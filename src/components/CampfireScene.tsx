import { useLayoutEffect, useRef } from "react";

const SCENE_WIDTH = 360;
const SCENE_HEIGHT = 202;

type Point = readonly [number, number];

export function CampfireScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const view = canvas?.ownerDocument.defaultView;
    if (!canvas || !view || view.navigator.userAgent.includes("jsdom")) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animation = 0;
    let animationFrame = 0;
    let stopped = false;
    const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");

    const pixel = (x: number, y: number, width: number, height: number, color: string) => {
      context.fillStyle = color;
      context.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
    };

    const polygon = (points: readonly Point[], color: string) => {
      const first = points[0];
      if (!first) return;
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(first[0], first[1]);
      for (const [x, y] of points.slice(1)) context.lineTo(x, y);
      context.closePath();
      context.fill();
    };

    const tree = (x: number, y: number, scale: number, dark: boolean) => {
      const trunk = dark ? "#27180e" : "#3a2416";
      const leafOne = dark ? "#092220" : "#123b34";
      const leafTwo = dark ? "#0d302b" : "#1b4f41";
      pixel(x - 2 * scale, y - 24 * scale, 4 * scale, 28 * scale, trunk);
      polygon([[x, y - 66 * scale], [x - 22 * scale, y - 28 * scale], [x + 22 * scale, y - 28 * scale]], leafOne);
      polygon([[x, y - 52 * scale], [x - 27 * scale, y - 12 * scale], [x + 27 * scale, y - 12 * scale]], leafTwo);
      polygon([[x, y - 34 * scale], [x - 20 * scale, y + 4 * scale], [x + 20 * scale, y + 4 * scale]], leafOne);
    };

    const drawComputer = (x: number, y: number) => {
      pixel(x, y, 25, 18, "#8d98a8");
      pixel(x + 3, y + 3, 19, 12, "#1b2028");
      pixel(x + 6, y + 5, 13, 8, "#283b4a");
      pixel(x + 5, y + 20, 17, 6, "#6b7482");
      pixel(x + 1, y + 26, 26, 6, "#55606e");
      pixel(x + 22, y + 28, 3, 3, "#a760bc");
    };

    const drawTent = (x: number, y: number) => {
      polygon([[x, y], [x + 38, y - 35], [x + 76, y]], "#6d331b");
      polygon([[x + 8, y - 2], [x + 38, y - 29], [x + 68, y - 2]], "#c06125");
      polygon([[x + 28, y], [x + 42, y - 20], [x + 52, y]], "#211410");
      pixel(x + 11, y - 6, 4, 4, "#f29b2d");
      pixel(x + 61, y - 6, 4, 4, "#f29b2d");
    };

    const drawBench = (x: number, y: number, flipped: boolean) => {
      const direction = flipped ? -1 : 1;
      pixel(x, y, 48 * direction, 5, "#7a431f");
      pixel(x + 4 * direction, y + 6, 42 * direction, 4, "#4b2a18");
      pixel(x + 10 * direction, y + 10, 4 * direction, 14, "#29170e");
      pixel(x + 35 * direction, y + 10, 4 * direction, 14, "#29170e");
    };

    const drawBackpack = (x: number, y: number) => {
      pixel(x, y, 19, 27, "#8f4026");
      pixel(x + 3, y - 6, 13, 8, "#6e2f20");
      pixel(x + 4, y + 7, 11, 7, "#b7562c");
      pixel(x + 15, y + 9, 5, 12, "#4b2719");
    };

    const drawCampfire = (x: number, y: number) => {
      pixel(x - 18, y + 9, 36, 5, "#2d180c");
      pixel(x - 22, y + 12, 18, 4, "#5b2c12");
      pixel(x + 4, y + 12, 18, 4, "#5b2c12");
      pixel(x - 2, y - 9 + Math.round(Math.sin(animation / 10) * 2), 5, 17, "#fff0a6");
      pixel(x - 8, y - 4 + Math.round(Math.cos(animation / 9) * 2), 8, 18, "#ff8a19");
      pixel(x + 2, y - 2 + Math.round(Math.sin(animation / 8) * 2), 8, 16, "#f44313");
      pixel(x - 4, y - 17, 7, 10, "#ffc93f");
    };

    const draw = () => {
      const cssWidth = Math.max(1, canvas.clientWidth);
      const cssHeight = Math.max(1, canvas.clientHeight);
      const deviceScale = Math.min(view.devicePixelRatio || 1, 2);
      const renderWidth = Math.round(cssWidth * deviceScale);
      const renderHeight = Math.round(cssHeight * deviceScale);
      if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
        canvas.width = renderWidth;
        canvas.height = renderHeight;
      }

      const logicalHeight = Math.max(SCENE_HEIGHT, SCENE_WIDTH * (cssHeight / cssWidth));
      const sceneOffset = logicalHeight - SCENE_HEIGHT;
      const renderScale = (cssWidth / SCENE_WIDTH) * deviceScale;
      context.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      context.imageSmoothingEnabled = false;

      const sky = context.createLinearGradient(0, 0, 0, logicalHeight);
      sky.addColorStop(0, "#050918");
      sky.addColorStop(Math.max(0.3, sceneOffset / logicalHeight), "#102b46");
      sky.addColorStop(1, "#101410");
      context.fillStyle = sky;
      context.fillRect(0, 0, SCENE_WIDTH, logicalHeight);

      const starFieldHeight = Math.max(73, sceneOffset + 73);
      const starCount = Math.ceil(74 * (logicalHeight / SCENE_HEIGHT));
      for (let index = 0; index < starCount; index += 1) {
        const x = (index * 47) % SCENE_WIDTH;
        const y = 8 + ((index * 29) % starFieldHeight);
        const bright = (index + Math.floor(animation / 18)) % 5 === 0;
        pixel(x, y, bright ? 2 : 1, bright ? 2 : 1, bright ? "#fff0bd" : "#5b7392");
      }

      context.save();
      context.translate(0, sceneOffset);
      polygon([[0, 108], [42, 48], [87, 110]], "#0b2133");
      polygon([[58, 118], [124, 44], [184, 118]], "#12314d");
      polygon([[145, 112], [213, 58], [276, 112]], "#0d2942");
      polygon([[238, 116], [314, 44], [382, 116]], "#102d45");
      polygon([[42, 48], [54, 67], [32, 67]], "#284d62");
      polygon([[124, 44], [141, 66], [105, 66]], "#315d70");
      polygon([[314, 44], [330, 68], [294, 68]], "#2b5367");

      pixel(0, 108, SCENE_WIDTH, 94, "#0c1e1b");
      polygon([[0, 139], [70, 124], [134, 135], [202, 119], [280, 132], [360, 120], [360, 202], [0, 202]], "#173b32");
      polygon([[0, 160], [44, 147], [102, 154], [181, 143], [252, 154], [360, 145], [360, 202], [0, 202]], "#244a3c");
      polygon([[0, 178], [83, 168], [151, 177], [225, 163], [288, 174], [360, 166], [360, 202], [0, 202]], "#1b332c");

      tree(14, 142, 0.78, true);
      tree(49, 136, 0.7, true);
      tree(314, 142, 0.85, true);
      tree(342, 137, 0.65, true);
      tree(276, 136, 0.56, false);
      tree(112, 138, 0.46, false);
      drawTent(29, 154);
      drawComputer(41, 158);
      drawBench(104, 161, false);
      drawBench(255, 161, true);
      drawBackpack(306, 158);
      drawCampfire(180, 161);
      pixel(0, 195, SCENE_WIDTH, 7, "#030509");
      context.restore();
    };

    const render = () => {
      if (stopped) return;
      animation += 1;
      draw();
      if (!reducedMotion.matches) animationFrame = view.requestAnimationFrame(render);
    };

    const restart = () => {
      view.cancelAnimationFrame(animationFrame);
      draw();
      if (!reducedMotion.matches) animationFrame = view.requestAnimationFrame(render);
    };

    const resizeObserver = new view.ResizeObserver(restart);
    resizeObserver.observe(canvas);
    reducedMotion.addEventListener("change", restart);
    restart();

    return () => {
      stopped = true;
      view.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", restart);
    };
  }, []);

  return (
    <div className="home-camp-scene" aria-hidden="true">
      <canvas ref={canvasRef} className="home-camp-scene__canvas" />
      <span className="home-camp-scene__glow" />
    </div>
  );
}
