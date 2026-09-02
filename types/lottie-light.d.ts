// lottie-web ships types only for its main entry; the light build (SVG
// renderer only, ~40% smaller, no eval) is the one we lazy-load for podium
// animations. Re-export the same types for that path.
declare module "lottie-web/build/player/lottie_light" {
  import lottie from "lottie-web";
  export default lottie;
}
