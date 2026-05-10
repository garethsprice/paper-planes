// Particle nebula on a spherical shell so it surrounds the user in VR/360°.
// Hidden by default; toggled with the 'N' key. Per-frame rotation + tint
// happen in the animation loop (it reads the centroid).

import * as THREE from 'three';

export function createNebula(scene: THREE.Scene): THREE.Points {
  const N = 400;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 12 + Math.random() * 18;
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.3,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    color: 0x80b8ff,
  });
  const nebula = new THREE.Points(geom, mat);
  nebula.visible = false; // 'N' toggles
  scene.add(nebula);
  return nebula;
}
