import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LAYER_AVATAR, LAYER_WORLD, setLayerRecursive } from '../core/RenderLayers';
import { PLAYER_FEET_OFFSET, PLAYER_HEIGHT } from './PlayerController';

/**
 * The player's body, from Kenney's CC0 "Blocky Characters" pack. It is only ever seen
 * through a portal (see LAYER_AVATAR), so it exists to make the player recognisable in
 * their own portal views rather than to be inspected up close.
 *
 * The pack's rig is plain node animation - no skin - which lets clips be recombined by
 * filtering tracks per body part: the legs walk while the arms stay locked on the gun.
 */

/** Rest-pose height of the model in its own units: soles at 0, top of head at 2.7. */
const MODEL_HEIGHT = 2.7;
const MODEL_SCALE = PLAYER_HEIGHT / MODEL_HEIGHT;

/** Where the gun sits in the right arm's local frame - the far, open end of the limb. */
const HAND_OFFSET = new THREE.Vector3(-0.2, -0.92, 0.06);
/** These characters are built from chunky blocks; a life-sized gun reads as a twig on them. */
const HELD_GUN_SCALE = 1.4;

const WALK_SPEED = 2.6;
const SPRINT_SPEED = 5.5;
const FADE = 0.15;
/** Legs the walk cycle would otherwise leave frozen mid-stride, splayed for a jump. */
const AIR_LEG_SWING = 0.55;
/** The head tracks the aim, but not all the way - a full crank looks broken. */
const HEAD_PITCH_FOLLOW = 0.7;

const ARM_NODES = ['arm-left', 'arm-right'];
const LEG_NODES = ['leg-left', 'leg-right'];

const PITCH_AXIS = new THREE.Vector3(1, 0, 0);

const modelUrls = import.meta.glob('../assets/players/Models/GLB format/*.glb', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const textureUrls = import.meta.glob('../assets/players/Models/GLB format/Textures/*.png', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

function assetLoader(map: Record<string, () => Promise<string>>, fileName: string): () => Promise<string> {
  const key = Object.keys(map).find((path) => path.endsWith(`/${fileName}`));
  if (!key) throw new Error(`Player asset not found: ${fileName}`);
  return map[key];
}

/** The node a track drives, e.g. "arm-right.quaternion" -> "arm-right". */
function trackNode(track: THREE.KeyframeTrack): string {
  return track.name.slice(0, track.name.lastIndexOf('.'));
}

function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip {
  const clip = clips.find((c) => c.name === name);
  if (!clip) throw new Error(`Character clip missing: ${name}`);
  return clip;
}

function tracksFrom(clip: THREE.AnimationClip, nodes: string[], keep: boolean): THREE.KeyframeTrack[] {
  return clip.tracks.filter((track) => nodes.includes(trackNode(track)) === keep).map((track) => track.clone());
}

/**
 * Slips a parent between a node and its own parent, inheriting the node's offset so the
 * new pivot turns about the same point. Aiming rides on these rather than on the nodes
 * themselves: the mixer owns node rotations and skips rewriting a pose that hasn't
 * changed, so a rotation folded in afterwards would compound frame after frame.
 */
function insertPivot(node: THREE.Object3D): THREE.Object3D {
  const parent = node.parent;
  if (!parent) throw new Error(`Cannot pivot a detached node: ${node.name}`);
  const pivot = new THREE.Object3D();
  pivot.position.copy(node.position);
  node.position.set(0, 0, 0);
  parent.add(pivot);
  pivot.add(node);
  return pivot;
}

/** A one-keyframe rotation track, for poses the pack does not ship (there is no jump clip). */
function poseTrack(node: string, pitch: number): THREE.QuaternionKeyframeTrack {
  const q = new THREE.Quaternion().setFromAxisAngle(PITCH_AXIS, pitch);
  return new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, [0], [q.x, q.y, q.z, q.w]);
}

type Locomotion = 'idle' | 'walk' | 'sprint' | 'air';

export interface AvatarState {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  speed: number;
  grounded: boolean;
}

export class PlayerAvatar {
  /** Sits at the scene origin: the body hangs off it, the gun anchor stays in world space. */
  readonly object = new THREE.Group();
  /** Follows the hand but is oriented by where the player looks, so the gun always aims true. */
  readonly gunAnchor = new THREE.Object3D();

  private readonly body = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly locomotions: Record<Locomotion, THREE.AnimationAction>;
  private readonly holdAction: THREE.AnimationAction;
  private readonly shootAction: THREE.AnimationAction;
  private readonly headPivot: THREE.Object3D;
  private readonly armPivots: THREE.Object3D[];
  private readonly handPoint = new THREE.Object3D();

  private state: Locomotion = 'idle';
  /** Portal views only (your own body) or everywhere (an opponent's). */
  private layer = LAYER_AVATAR;
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly handWorld = new THREE.Vector3();

  /** `character` is which of the pack's characters to wear: any letter a-r (the skin). */
  static async load(character: string): Promise<PlayerAvatar> {
    const modelUrl = await assetLoader(modelUrls, `character-${character}.glb`)();
    const textureUrl = await assetLoader(textureUrls, `texture-${character}.png`)();

    // The GLB points at its texture with a relative path that only resolves next to the
    // original file; after bundling, both live elsewhere under hashed names.
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => (url.endsWith(`texture-${character}.png`) ? textureUrl : url));

    const gltf = await new GLTFLoader(manager).loadAsync(modelUrl);
    return new PlayerAvatar(gltf.scene, gltf.animations);
  }

  private constructor(model: THREE.Group, clips: THREE.AnimationClip[]) {
    model.scale.setScalar(MODEL_SCALE);
    this.body.add(model);
    this.object.add(this.body, this.gunAnchor);
    setLayerRecursive(this.object, LAYER_AVATAR);

    this.headPivot = insertPivot(requireNode(model, 'head'));
    this.armPivots = ARM_NODES.map((name) => insertPivot(requireNode(model, name)));
    requireNode(model, 'arm-right').add(this.handPoint);
    this.handPoint.position.copy(HAND_OFFSET);

    this.mixer = new THREE.AnimationMixer(model);
    const rest = findClip(clips, 'static');
    const idleClip = findClip(clips, 'idle');

    // Locomotion drives everything but the arms; the arms are held by their own action so
    // the gun stays shouldered through every stride. Idle borrows the rest pose's legs
    // because the pack's idle clip animates only the upper body, which would otherwise
    // leave the legs frozen wherever the walk cycle stopped.
    const idle = new THREE.AnimationClip('idle-legs', -1, [
      ...tracksFrom(idleClip, ARM_NODES, false),
      ...tracksFrom(rest, LEG_NODES, true),
    ]);
    const air = new THREE.AnimationClip('air', -1, [
      ...tracksFrom(idleClip, ARM_NODES, false),
      poseTrack('leg-left', -AIR_LEG_SWING),
      poseTrack('leg-right', AIR_LEG_SWING * 0.6),
    ]);
    const walk = new THREE.AnimationClip('walk-legs', -1, tracksFrom(findClip(clips, 'walk'), ARM_NODES, false));
    const sprint = new THREE.AnimationClip('sprint-legs', -1, tracksFrom(findClip(clips, 'sprint'), ARM_NODES, false));

    this.locomotions = {
      idle: this.mixer.clipAction(idle),
      walk: this.mixer.clipAction(walk),
      sprint: this.mixer.clipAction(sprint),
      air: this.mixer.clipAction(air),
    };
    this.locomotions.idle.play();

    this.holdAction = this.mixer.clipAction(
      new THREE.AnimationClip('hold', -1, tracksFrom(findClip(clips, 'holding-both'), ARM_NODES, true)),
    );
    this.holdAction.play();

    this.shootAction = this.mixer.clipAction(
      new THREE.AnimationClip('shoot', -1, tracksFrom(findClip(clips, 'holding-both-shoot'), ARM_NODES, true)),
    );
    this.shootAction.setLoop(THREE.LoopOnce, 1);
    this.shootAction.weight = 0;

    this.mixer.addEventListener('finished', (event) => {
      if ((event as { action?: THREE.AnimationAction }).action !== this.shootAction) return;
      this.shootAction.stop();
      this.shootAction.weight = 0;
      this.holdAction.weight = 1;
    });
  }

  /**
   * Parents an object to the hand: it tracks the arm but aims where the player looks.
   * Safe to repeat when the object moves to a new avatar (a skin change).
   */
  attachToHand(object: THREE.Object3D): void {
    const base = (object.userData.handBaseScale ??= object.scale.clone()) as THREE.Vector3;
    object.scale.copy(base).multiplyScalar(HELD_GUN_SCALE);
    this.gunAnchor.add(object);
    setLayerRecursive(object, this.layer);
  }

  /** An opponent's body: drawn by the main camera too, not only in portal views. */
  setSeenByMainCamera(): void {
    this.layer = LAYER_WORLD;
    setLayerRecursive(this.object, LAYER_WORLD);
  }

  /** Frees the model's GPU resources; anything held in the hand is left alone. */
  dispose(): void {
    this.mixer.stopAllAction();
    this.object.removeFromParent();
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as THREE.MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
    });
  }

  /** Snaps the arms into the recoil pose; the hold pose resumes when the clip ends. */
  shoot(): void {
    this.holdAction.weight = 0;
    this.shootAction.reset();
    this.shootAction.weight = 1;
    this.shootAction.play();
  }

  update(dt: number, state: AvatarState): void {
    this.body.position.set(state.position.x, state.position.y - PLAYER_FEET_OFFSET, state.position.z);
    // The pack's characters face +Z; three.js objects face -Z, hence the half turn.
    this.body.rotation.y = state.yaw + Math.PI;

    this.setLocomotion(pickLocomotion(state.speed, state.grounded), state.speed);
    this.mixer.update(dt);

    // Aiming: the arms swing to where the player looks, the head follows part of the way.
    for (const pivot of this.armPivots) pivot.rotation.x = -state.pitch;
    this.headPivot.rotation.x = -state.pitch * HEAD_PITCH_FOLLOW;

    this.handPoint.getWorldPosition(this.handWorld);
    this.gunAnchor.position.copy(this.handWorld);
    this.lookEuler.set(state.pitch, state.yaw, 0);
    this.gunAnchor.quaternion.setFromEuler(this.lookEuler);
  }

  private setLocomotion(next: Locomotion, speed: number): void {
    const action = this.locomotions[next];
    // Stretch the stride to the actual ground speed so the feet do not skate.
    if (next === 'walk') action.timeScale = Math.max(0.6, speed / WALK_SPEED);
    else if (next === 'sprint') action.timeScale = Math.max(0.8, speed / SPRINT_SPEED);

    if (next === this.state) return;
    this.locomotions[this.state].fadeOut(FADE);
    action.reset().setEffectiveWeight(1).fadeIn(FADE).play();
    this.state = next;
  }
}

function requireNode(model: THREE.Object3D, name: string): THREE.Object3D {
  const node = model.getObjectByName(name);
  if (!node) throw new Error(`Character node missing: ${name}`);
  return node;
}

function pickLocomotion(speed: number, grounded: boolean): Locomotion {
  if (!grounded) return 'air';
  if (speed > SPRINT_SPEED) return 'sprint';
  if (speed > 0.4) return 'walk';
  return 'idle';
}
