//! RFC 3339 UTC timestamps with milliseconds (`2026-10-20T14:28:57.123Z`), without a date
//! crate: the Host only ever formats the current time.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_rfc3339() -> String {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_millis(since_epoch.as_millis() as i64)
}

fn format_millis(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        second_of_day / 3600,
        second_of_day % 3600 / 60,
        second_of_day % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format_millis(0), "1970-01-01T00:00:00.000Z");
        // 2000-02-29 (leap day) 12:34:56.789
        assert_eq!(format_millis(951_827_696_789), "2000-02-29T12:34:56.789Z");
        // 2026-10-20 14:28:57.005
        assert_eq!(format_millis(1_792_506_537_005), "2026-10-20T14:28:57.005Z");
        // 2100-03-01, the day after a non-leap century February
        assert_eq!(format_millis(4_107_542_400_000), "2100-03-01T00:00:00.000Z");
    }

    #[test]
    fn now_is_well_formed() {
        let now = now_rfc3339();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.starts_with("20"));
    }
}
