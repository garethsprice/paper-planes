// Full-sphere star field. acos(2·rand-1) gives uniform points on the sphere
// (avoids polar clumping). 1200 ≈ same density as the old 600-on-hemisphere
// pattern, and now fills the lower hemisphere too for VR/360° viewing.

import * as THREE from 'three';

export function createStars(scene: THREE.Scene): THREE.Points {
  const STAR_COUNT = 1200;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const r = 130 + Math.random() * 40; // beyond the mountain ring
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xc8d8ff,
    size: 0.45,
    sizeAttenuation: true,
    fog: false,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const stars = new THREE.Points(geom, mat);
  scene.add(stars);
  return stars;
}
