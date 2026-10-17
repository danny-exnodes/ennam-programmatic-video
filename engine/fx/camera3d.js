// Pinhole camera for 3D nature scenes. World: metres, Y up, water plane at
// Y = 0, camera looks roughly along +Z. Projects to the shot's logical
// 2D coordinates (W × H, y down) so 3D elements line up with everything
// else the shot draws.

export function makeCamera(o, W, H) {
  const pos = [o.x ?? 0, o.height ?? 0.6, o.z ?? 0];
  const pitch = o.pitch ?? 0.1; // radians, positive = looking down
  const yaw = o.yaw ?? 0;
  const fov = ((o.fov ?? 50) * Math.PI) / 180; // vertical
  const f = H / 2 / Math.tan(fov / 2);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // basis
  const F = [sy * cp, -sp, cy * cp];
  const R = [cy, 0, -sy];
  const U = [sy * sp, cp, cy * sp];
  const cam = {
    pos, pitch, yaw, f, F, R, U, W, H,
    focus: o.focus ?? 3, // focus distance (m) for depth of field
    aperture: o.aperture ?? 0, // blur strength (px at 1 diopter of defocus)
    /** world -> [sx, sy, depth]; depth <= 0 means behind camera */
    project(x, y, z) {
      const dx = x - pos[0], dy = y - pos[1], dz = z - pos[2];
      const zc = dx * F[0] + dy * F[1] + dz * F[2];
      const xc = dx * R[0] + dy * R[1] + dz * R[2];
      const yc = dx * U[0] + dy * U[1] + dz * U[2];
      if (zc <= 1e-4) return [NaN, NaN, zc];
      return [W / 2 + (f * xc) / zc, H / 2 - (f * yc) / zc, zc];
    },
    /** screen px per metre at a camera depth */
    scaleAt(depth) {
      return f / Math.max(1e-4, depth);
    },
    /** ray from screen point -> intersection with horizontal plane Y = py (or null) */
    unproject(sx, sy, py = 0) {
      const a = (sx - W / 2) / f, b = -(sy - H / 2) / f;
      const d = [F[0] + a * R[0] + b * U[0], F[1] + a * R[1] + b * U[1], F[2] + a * R[2] + b * U[2]];
      if (d[1] >= -1e-6) return null;
      const t = (py - pos[1]) / d[1];
      return [pos[0] + d[0] * t, py, pos[2] + d[2] * t];
    },
    /** screen y of the horizon line (may be off-screen) */
    horizonY() {
      // direction (0,0,1) at infinity
      const zc = F[2], yc = U[2];
      return H / 2 - (f * yc) / zc;
    },
    /** defocus blur (logical px) for something at camera depth d */
    blurAt(d) {
      if (!cam.aperture) return 0;
      return cam.aperture * Math.abs(1 / Math.max(0.05, d) - 1 / cam.focus);
    },
  };
  return cam;
}

/** Same camera mirrored in the water plane (for planar reflections). */
export function mirrorProject(cam) {
  return (x, y, z) => cam.project(x, -y, z);
}
