import { useEffect, useRef, useState } from "react";
import type { HostBridge } from "../../host-bridge";
import { connectPreviewFrame, createBridgeNonce } from "../preview/frame-channel";

/** How long to keep listening after the hello, so forged messages are counted too. */
const OBSERVE_MS = 8000;

/**
 * Spike S3 probe: frames a preview with the ADR-0010 attributes, exchanges bridge messages
 * and logs what was accepted and rejected through the Host. Phase 4's preview panel reuses
 * `frame-channel.ts`; this component is diagnostics only.
 */
export function PreviewFrameProbe({ bridge, url }: { bridge: HostBridge; url: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // A lazy state initialiser runs once per mount; useMemo may recompute and rotate the nonce.
  const [nonce] = useState(createBridgeNonce);
  const origin = new URL(url).origin;
  const src = `${url}?parent=${encodeURIComponent(window.location.origin)}&nonce=${nonce}`;
  const [status, setStatus] = useState("Waiting for the preview bridge…");

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let hellos = 0;
    let summaryTimer: ReturnType<typeof setTimeout> | undefined;

    const channel = connectPreviewFrame({
      frame: element,
      origin,
      nonce,
      onMessage(message) {
        if (message.type !== "bridge.hello") return;
        hellos += 1;
        setStatus(`Bridge connected (${message.version})`);
        channel.send({ type: "inspect.set", enabled: true });
        summaryTimer ??= setTimeout(report, OBSERVE_MS);
      },
    });

    function report() {
      const summary = {
        workbenchOrigin: window.location.origin,
        previewOrigin: origin,
        hellosAccepted: hellos,
        rejected: { ...channel.rejected },
        // Cross-origin frames expose no document to the parent.
        frameDocumentReadable: element!.contentDocument !== null,
      };
      bridge.log("info", `[s3] ${JSON.stringify(summary)}`);
      setStatus(`Probe finished: ${JSON.stringify(summary)}`);
    }

    // Report even if no hello ever arrives, so a blocked frame shows up as a result.
    const giveUp = setTimeout(() => summaryTimer ?? report(), 30_000);
    return () => {
      channel.dispose();
      clearTimeout(summaryTimer);
      clearTimeout(giveUp);
    };
  }, [bridge, nonce, origin]);

  return (
    <section aria-labelledby="preview-probe-title">
      <h2 id="preview-probe-title">Preview frame probe</h2>
      <p role="status">{status}</p>
      <iframe
        ref={frame}
        title="Preview"
        src={src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        allow=""
        referrerPolicy="no-referrer"
        width={640}
        height={240}
      />
    </section>
  );
}
