//! Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (ADR-0011).
//!
//! The Host assigns the runtime to the job before `runtime.initialize`. Children inherit job
//! membership, and the OS closes the job handle when the Host exits for any reason,
//! including being killed from Task Manager, so every descendant is terminated (RN-03).

use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::RawHandle;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct JobObject {
    handle: HANDLE,
}

// SAFETY: a job handle is a kernel object reference that may be used from any thread.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// Creates an unnamed job that terminates its processes when the last handle closes.
    /// Null security attributes make the handle non-inheritable: a child holding it would
    /// keep the job alive after the Host dies.
    pub fn new_kill_on_close() -> io::Result<Self> {
        // SAFETY: null attributes and name are valid; the handle is checked before use.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };

        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid "no limits" value.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is the struct this information class expects, with its exact size.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Adds a process (and its future children) to the job.
    pub fn assign(&self, process: RawHandle) -> io::Result<()> {
        // SAFETY: `process` is a live process handle owned by the caller.
        let ok = unsafe { AssignProcessToJobObject(self.handle, process as HANDLE) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed exactly once.
        unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    fn is_alive(pid: u32) -> bool {
        // SAFETY: OpenProcess returns null for an exited process; the handle is closed below.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            alive
        }
    }

    fn wait_until_dead(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !is_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// Closing the job kills the assigned process and the grandchild it started.
    #[test]
    fn closing_the_job_kills_the_whole_tree() {
        // Once released through stdin (after job assignment, as the Host does before
        // `initialize`), PowerShell starts a hidden grandchild that would otherwise outlive
        // it, prints the grandchild's pid, then waits.
        let script = "$null = [Console]::In.ReadLine(); $p = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; Write-Output $p.Id; Start-Sleep 60";
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn powershell");

        let job = JobObject::new_kill_on_close().expect("create job");
        job.assign(child.as_raw_handle()).expect("assign to job");
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), b"go\n").expect("release");

        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut line,
        )
        .expect("read grandchild pid");
        let grandchild: u32 = line.trim().parse().expect("grandchild pid");
        let parent = child.id();
        assert!(is_alive(parent) && is_alive(grandchild));

        drop(job);

        assert!(wait_until_dead(parent), "assigned process survived the job");
        assert!(wait_until_dead(grandchild), "grandchild survived the job");
        let _ = child.wait();
    }
}
