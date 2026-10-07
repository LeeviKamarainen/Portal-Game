import * as THREE from 'three';
import { PORTAL_COLORS, type PortalColor } from '../portals/Portal';

/**
 * The portal device, built from primitives (the asset pack ships characters, not weapons).
 * Modelled around the grip so the origin can be dropped straight onto a hand or a camera,
 * and aimed down -Z to match three.js's camera convention.
 */

const SHELL_COLOR = 0xd7dce4;
const CASING_COLOR = 0x474e5c;
const GRIP_COLOR = 0x23262e;
const CLAW_COUNT = 3;
const CLAW_RADIUS = 0.062;

/** How long the muzzle stays lit after a shot, in seconds. */
const FLASH_DECAY = 0.14;
const HALO_OPACITY = 0.3;

function part(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

export class PortalGunModel {
  readonly object = new THREE.Group();

  private readonly core: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly muzzle: THREE.Mesh;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private readonly muzzleMaterial: THREE.MeshBasicMaterial;
  private readonly owned: Array<{ dispose(): void }> = [];

  private flash = 0;
  private readonly palette: Readonly<Record<PortalColor, number>>;

  /** `palette`: the owner's portal colours. */
  constructor(color: PortalColor = 'orange', palette: Readonly<Record<PortalColor, number>> = PORTAL_COLORS) {
    this.palette = palette;
    const shell = this.own(new THREE.MeshStandardMaterial({ color: SHELL_COLOR, roughness: 0.45, metalness: 0.1 }));
    const casing = this.own(new THREE.MeshStandardMaterial({ color: CASING_COLOR, roughness: 0.6, metalness: 0.3 }));
    const grip = this.own(new THREE.MeshStandardMaterial({ color: GRIP_COLOR, roughness: 0.85 }));

    this.coreMaterial = this.own(new THREE.MeshBasicMaterial());
    this.haloMaterial = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: HALO_OPACITY, depthWrite: false }));
    this.muzzleMaterial = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));

    this.object.add(
      part(this.own(new THREE.BoxGeometry(0.062, 0.17, 0.082)), grip, 0, -0.08, 0.012),
      part(this.own(new THREE.BoxGeometry(0.02, 0.045, 0.016)), casing, 0, -0.012, -0.048),
      part(this.own(new THREE.BoxGeometry(0.104, 0.132, 0.28)), shell, 0, 0.058, -0.13),
      part(this.own(new THREE.BoxGeometry(0.112, 0.142, 0.045)), shell, 0, 0.055, 0.002),
      part(this.own(new THREE.BoxGeometry(0.07, 0.05, 0.15)), casing, 0, 0.135, -0.16),
    );

    const barrel = part(this.own(new THREE.CylinderGeometry(0.048, 0.055, 0.16, 14)), casing, 0, 0.058, -0.32);
    barrel.rotation.x = Math.PI / 2;
    this.object.add(barrel);

    // Three prongs splayed around the muzzle, angled outward so the emitter sits in a cage.
    const clawGeometry = this.own(new THREE.BoxGeometry(0.024, 0.024, 0.19));
    for (let i = 0; i < CLAW_COUNT; i++) {
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 0.058, -0.34);
      pivot.rotation.z = (i / CLAW_COUNT) * Math.PI * 2;
      const claw = part(clawGeometry, shell, 0, CLAW_RADIUS, -0.08);
      claw.rotation.x = -0.22;
      pivot.add(claw);
      this.object.add(pivot);
    }

    // The emitter sits out in the open between the prongs - tucked back into the shell it
    // would be hidden by the very body it is meant to light up.
    this.core = part(this.own(new THREE.SphereGeometry(0.038, 14, 10)), this.coreMaterial, 0, 0.058, -0.44);
    this.halo = part(this.own(new THREE.SphereGeometry(0.066, 14, 10)), this.haloMaterial, 0, 0.058, -0.44);
    this.muzzle = part(this.own(new THREE.SphereGeometry(0.05, 14, 10)), this.muzzleMaterial, 0, 0.058, -0.52);
    this.object.add(this.core, this.halo, this.muzzle);

    // Read-outs that stay visible from where the player actually stands: from behind the
    // gun the barrel hides the emitter, so the charge colour needs somewhere else to show.
    this.object.add(
      part(this.own(new THREE.BoxGeometry(0.05, 0.014, 0.13)), this.coreMaterial, 0, 0.128, -0.14),
      part(this.own(new THREE.SphereGeometry(0.016, 10, 8)), this.coreMaterial, 0, 0.095, -0.02),
    );

    this.charge(color);
    this.flash = 0;
    this.update(0);
  }

  private own<T extends { dispose(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }

  /** Recolour the emitter to the portal just fired and light the muzzle. */
  charge(color: PortalColor): void {
    const hex = this.palette[color];
    this.coreMaterial.color.setHex(hex);
    this.haloMaterial.color.setHex(hex);
    this.muzzleMaterial.color.setHex(hex);
    this.flash = 1;
  }

  update(dt: number): void {
    this.flash = Math.max(0, this.flash - dt / FLASH_DECAY);
    const pulse = 1 + this.flash * 1.6;
    this.core.scale.setScalar(pulse);
    this.halo.scale.setScalar(1 + this.flash * 0.9);
    this.haloMaterial.opacity = HALO_OPACITY + this.flash * 0.5;
    this.muzzleMaterial.opacity = this.flash * 0.85;
    this.muzzle.scale.setScalar(0.6 + this.flash * 0.9);
  }

  dispose(): void {
    for (const resource of this.owned) resource.dispose();
  }
}
