import { Composition, Still } from "remotion";
import { Demo, FPS, totalFrames } from "./Demo";
import { Social } from "./Social";

export const Root = () => (
  <>
    <Composition id="Demo" component={Demo} durationInFrames={totalFrames()} fps={FPS} width={1920} height={1080} />
    <Still
      id="Social"
      component={Social}
      width={1200}
      height={675}
      defaultProps={{ registered: "307992", calls: "2,043", endpoints: "69", answered: "30", seats: "2" }}
    />
  </>
);
