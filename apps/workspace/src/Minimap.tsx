import { useEffect, useRef } from 'react';
import { screenToWorld, type CanvasEngine } from '@kayospace/canvas';

const W = 200;
const H = 132;
const PAD = 6;

interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Мини-карта: вся доска в уменьшенном виде и рамка видимой части. Нажатие или перетаскивание
 * переносит туда вид. Снимок доски перерисовывается не чаще двух раз в секунду (на доске
 * в 20 000 объектов он занимает ~30 мс), рамка вида — каждый кадр движения камеры.
 */
export function Minimap({ engine }: { engine: CanvasEngine }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    let snap: HTMLCanvasElement | null = null;
    let area: Area | null = null;
    let k = 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    let dragging = false;

    const visibleQuad = () => {
      const cam = engine.getCamera();
      const { width, height } = engine.renderer;
      return [
        screenToWorld(cam, 0, 0),
        screenToWorld(cam, width, 0),
        screenToWorld(cam, width, height),
        screenToWorld(cam, 0, height),
      ];
    };

    /** Область карты: содержимое доски и видимая часть, с полями, в пропорциях карты. */
    const computeArea = (): void => {
      const quad = visibleQuad();
      const content = engine.scene.contentBounds();
      let minX = Math.min(...quad.map((p) => p.x));
      let minY = Math.min(...quad.map((p) => p.y));
      let maxX = Math.max(...quad.map((p) => p.x));
      let maxY = Math.max(...quad.map((p) => p.y));
      if (content) {
        minX = Math.min(minX, content.minX);
        minY = Math.min(minY, content.minY);
        maxX = Math.max(maxX, content.maxX);
        maxY = Math.max(maxY, content.maxY);
      }
      const iw = W - PAD * 2;
      const ih = H - PAD * 2;
      k = Math.min(iw / (maxX - minX), ih / (maxY - minY));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      area = {
        minX: cx - W / 2 / k,
        minY: cy - H / 2 / k,
        maxX: cx + W / 2 / k,
        maxY: cy + H / 2 / k,
      };
    };

    const drawSnapshot = (): void => {
      timer = null;
      computeArea();
      snap = area ? engine.renderer.exportRegion(engine.scene, area, k * dpr) : null;
      draw();
    };

    const draw = (): void => {
      raf = 0;
      if (!area) return;
      // Вид ушёл за край карты — перестроить карту.
      const quad = visibleQuad();
      const out = quad.some(
        (p) => p.x < area!.minX || p.x > area!.maxX || p.y < area!.minY || p.y > area!.maxY,
      );
      if (out && !timer && !dragging) {
        drawSnapshot();
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (snap) ctx.drawImage(snap, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      quad.forEach((p, i) => {
        const x = (p.x - area!.minX) * k;
        const y = (p.y - area!.minY) * k;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#3e63dd';
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    const scheduleSnapshot = (): void => {
      if (!timer) timer = setTimeout(drawSnapshot, 500);
    };
    const scheduleDraw = (): void => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    drawSnapshot();
    const offScene = engine.scene.onChange(scheduleSnapshot);
    const offCam = engine.onCamera(scheduleDraw);
    const theme = matchMedia('(prefers-color-scheme: dark)');
    theme.addEventListener('change', scheduleSnapshot);

    // Нажатие и перетаскивание — перенести вид.
    const go = (e: PointerEvent): void => {
      if (!area) return;
      const r = canvas.getBoundingClientRect();
      engine.centerOn({
        x: area.minX + (e.clientX - r.left) / k,
        y: area.minY + (e.clientY - r.top) / k,
      });
    };
    const down = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      go(e);
    };
    const move = (e: PointerEvent): void => {
      if (dragging) go(e);
    };
    const up = (): void => {
      dragging = false;
      // Пока тянули, карту не перестраивали — теперь можно.
      scheduleDraw();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    return () => {
      offScene();
      offCam();
      theme.removeEventListener('change', scheduleSnapshot);
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
  }, [engine]);

  return (
    <canvas
      ref={ref}
      className="minimap"
      style={{ width: W, height: H }}
      aria-label="Мини-карта доски"
      data-testid="minimap"
    />
  );
}
