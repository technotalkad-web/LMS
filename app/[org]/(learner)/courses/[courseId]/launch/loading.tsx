import { LaunchFrameLoader } from "@/components/ui/launch-frame-loader";

/**
 * Module launch boundary. The launch page mints the attempt and token on the
 * server, so for a moment there is nothing to render: show the runtime's own
 * dark frame with a small "Opening module…" indicator — never a full-screen
 * overlay — and hand over to the real runtime as soon as it streams in.
 */
export default function LaunchLoading() {
  return <LaunchFrameLoader />;
}
