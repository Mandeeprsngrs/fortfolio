// The computer on the desk: Mandeep's About / Projects / Contact.
//
// Two states:
// • In the room, its glass shows a small idle screen (amber text, blinking
//   cursor) drawn into a canvas texture, so it reads as "this one does something".
// • Clicked, room.ts moves the camera in front of the monitor (like the TV game)
//   and this file lays a real HTML panel exactly over the glass: we project the
//   glass's four corners to screen pixels and size the panel to them. Real HTML
//   means real links, selectable text, screen-reader support, and content you
//   edit in Computer.astro rather than in a texture.
import * as THREE from 'three';

export const COMPUTER = 'computer';

// The glass, as fractions of the computer mesh's WORLD bounding box (the mesh
// is monitor + tower in one, axis-aligned, front facing −Z). Measured from a
// straight-on render: the dark tube spans x 0.624–1.284 and y 1.692–2.196 on
// the front face at z 4.03. Fractions rather than coordinates, for the same
// meshopt reason as the TV (see room.ts).
const GLASS_FRAC = { x0: 0.4788, x1: 0.7829, y0: 0.265, y1: 0.7845, z: 0.5485 };

const MIN_FIT_WIDTH = 480; // px; narrower than this and the panel fills the screen instead
const IDLE_W = 320;
const IDLE_H = 244; // ≈ the glass's 1.31:1

export function createComputer(opts: { scene: THREE.Scene; mesh: THREE.Object3D; panel: HTMLElement | null }) {
  const box = new THREE.Box3().setFromObject(opts.mesh);
  const size = box.getSize(new THREE.Vector3());
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x0 = lerp(box.min.x, box.max.x, GLASS_FRAC.x0);
  const x1 = lerp(box.min.x, box.max.x, GLASS_FRAC.x1);
  const y0 = lerp(box.min.y, box.max.y, GLASS_FRAC.y0);
  const y1 = lerp(box.min.y, box.max.y, GLASS_FRAC.y1);
  const z = box.min.z + GLASS_FRAC.z * size.z;

  const glass = {
    centre: new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, z),
    normal: new THREE.Vector3(0, 0, -1), // out of the screen, into the room
    w: x1 - x0,
    h: y1 - y0,
  };
  // Corners in screen order for the panel: top-left, top-right, bottom-right,
  // bottom-left as the viewer sees them (facing −Z, so world +X is on the left).
  const corners = [
    new THREE.Vector3(x1, y1, z),
    new THREE.Vector3(x0, y1, z),
    new THREE.Vector3(x0, y0, z),
    new THREE.Vector3(x1, y0, z),
  ];

  // ── Idle screen ──
  const canvas = document.createElement('canvas');
  canvas.width = IDLE_W;
  canvas.height = IDLE_H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const idle = new THREE.Mesh(
    new THREE.PlaneGeometry(glass.w, glass.h),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  idle.position.copy(glass.centre).addScaledVector(glass.normal, 0.004);
  idle.lookAt(idle.position.clone().add(glass.normal));
  idle.name = 'computer-idle-screen';
  opts.scene.add(idle);

  const AMBER = '#ffb347';
  function drawIdle(cursorOn: boolean) {
    ctx.fillStyle = '#120d06';
    ctx.fillRect(0, 0, IDLE_W, IDLE_H);
    ctx.font = 'bold 19px monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = AMBER;
    const lines = ['MANDEEP OS 1.0', '', '> about_me', '> projects', '> contact', ''];
    lines.forEach((l, i) => ctx.fillText(l, 18, 16 + i * 26));
    ctx.fillText('CLICK TO OPEN', 18, 16 + 6 * 26);
    if (cursorOn) ctx.fillRect(18 + ctx.measureText('CLICK TO OPEN').width + 6, 16 + 6 * 26, 12, 20);
    // scanlines
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < IDLE_H; y += 3) ctx.fillRect(0, y, IDLE_W, 1);
    texture.needsUpdate = true;
  }
  let blink = 0;
  let cursor = true;
  drawIdle(cursor);

  // ── The HTML panel ──
  const panel = opts.panel;
  const tabs = panel ? [...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')] : [];
  function selectTab(tab: HTMLButtonElement) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const pane = panel!.querySelector<HTMLElement>(`#${t.getAttribute('aria-controls')}`);
      if (pane) pane.hidden = !on;
    }
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    // Arrow keys move between tabs (the usual tablist behaviour).
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });

  let open = false;
  const v = new THREE.Vector3();
  function layout(camera: THREE.Camera, canvasEl: HTMLCanvasElement) {
    if (!panel || !open) return;
    // project() uses the camera's matrices, which three.js only refreshes when
    // it renders. We're called right after the camera moved, so refresh first.
    camera.updateMatrixWorld();
    const r = canvasEl.getBoundingClientRect();
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of corners) {
      v.copy(c).project(camera);
      xs.push(((v.x + 1) / 2) * r.width);
      ys.push(((1 - v.y) / 2) * r.height);
    }
    let left = Math.min(...xs);
    let top = Math.min(...ys);
    let width = Math.max(...xs) - left;
    let height = Math.max(...ys) - top;
    // On a phone the glass is only ~300 px wide: text sized to it would be
    // ~10 px. Below MIN_FIT_WIDTH the panel "pops out" to fill most of the
    // screen (below the Back button) instead of matching the glass exactly.
    if (width < MIN_FIT_WIDTH) {
      const m = 12;
      left = m;
      top = 64;
      width = r.width - 2 * m;
      height = r.height - top - m;
    }
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    // Text scales with the panel (designed at 640 px wide), within limits.
    panel.style.setProperty('--cs-scale', String(THREE.MathUtils.clamp(width / 640, 0.85, 1.4)));
  }

  return {
    pickTargets: [opts.mesh, idle],
    glass,
    open(camera: THREE.Camera, canvasEl: HTMLCanvasElement) {
      if (!panel) return;
      open = true;
      idle.visible = false;
      panel.hidden = false;
      layout(camera, canvasEl);
      (tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0])?.focus();
    },
    close() {
      open = false;
      idle.visible = true;
      if (panel) panel.hidden = true;
    },
    layout,
    update(dt: number) {
      if (open) return;
      blink += dt;
      if (blink > 0.55) {
        blink = 0;
        cursor = !cursor;
        drawIdle(cursor);
      }
    },
    dispose() {
      opts.scene.remove(idle);
      idle.geometry.dispose();
      (idle.material as THREE.Material).dispose();
      texture.dispose();
    },
  };
}

export type Computer = ReturnType<typeof createComputer>;
