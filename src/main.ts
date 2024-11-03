import "./style.css";
import * as THREE from "three";
import Stats from "three/addons/libs/stats.module.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";

type EffectController = {
  separation: number;
  alignment: number;
  cohesion: number;
  size: number;
  count: number;
};

/* TEXTURE WIDTH FOR SIMULATION */
const WIDTH = 64;
const BIRDS = WIDTH * WIDTH;

/* BAKE ANIMATION INTO TEXTURE and CREATE GEOMETRY FROM BASE MODEL */
const BirdGeometry: THREE.BufferGeometry = new THREE.BufferGeometry();
let textureAnimation: THREE.DataTexture;
let durationAnimation: number;
let birdMesh: THREE.Mesh;
let materialShader: THREE.WebGLProgramParametersWithUniforms;
let indicesPerBird: number;

let container: HTMLDivElement;
let stats: Stats;
let camera: THREE.PerspectiveCamera;
let scene: THREE.Scene;
let renderer: THREE.WebGLRenderer;

const BOUNDS = 800;
const BOUNDS_HALF = BOUNDS / 2;

let last = performance.now();

let gpuCompute: GPUComputationRenderer;
let velocityVariable: any;
let positionVariable: any;
let positionUniforms: any;
let velocityUniforms: any;

let birdPositionShader: string;
let birdVelocityShader: string;
let vertexShader: string;

function nextPowerOf2(n: number): number {
  return Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)));
}

function lerp(value1: number, value2: number, amount: number): number {
  amount = Math.max(Math.min(amount, 1), 0);
  return value1 + (value2 - value1) * amount;
}

new GLTFLoader().load("boid_basic.glb", function (gltf) {
  const animations = gltf.animations;
  durationAnimation = Math.round((animations[0]?.duration ?? 0) * 60);
  if (!("geometry" in gltf.scene.children[0])) return;

  const birdGeo = gltf.scene.children[0].geometry as THREE.BufferGeometry;
  const morphAttributes = birdGeo.morphAttributes.position;
  const tHeight = nextPowerOf2(durationAnimation);
  const tWidth = nextPowerOf2(birdGeo.getAttribute("position").count);

  if (!birdGeo.index) {
    console.error("no index");
    return;
  }

  indicesPerBird = birdGeo.index.count;
  const tData = new Float32Array(4 * tWidth * tHeight);

  for (let i = 0; i < tWidth; i++) {
    for (let j = 0; j < tHeight; j++) {
      const offset = j * tWidth * 4;

      const curMorph = Math.floor(
        (j / durationAnimation) * morphAttributes.length
      );
      const nextMorph =
        (Math.floor((j / durationAnimation) * morphAttributes.length) + 1) %
        morphAttributes.length;
      const lerpAmount = ((j / durationAnimation) * morphAttributes.length) % 1;

      if (j < durationAnimation) {
        let d0, d1;

        d0 = morphAttributes[curMorph].array[i * 3];
        d1 = morphAttributes[nextMorph].array[i * 3];

        if (d0 !== undefined && d1 !== undefined)
          tData[offset + i * 4] = lerp(d0, d1, lerpAmount);

        d0 = morphAttributes[curMorph].array[i * 3 + 1];
        d1 = morphAttributes[nextMorph].array[i * 3 + 1];

        if (d0 !== undefined && d1 !== undefined)
          tData[offset + i * 4 + 1] = lerp(d0, d1, lerpAmount);

        d0 = morphAttributes[curMorph].array[i * 3 + 2];
        d1 = morphAttributes[nextMorph].array[i * 3 + 2];

        if (d0 !== undefined && d1 !== undefined)
          tData[offset + i * 4 + 2] = lerp(d0, d1, lerpAmount);

        tData[offset + i * 4 + 3] = 1;
      }
    }
  }

  textureAnimation = new THREE.DataTexture(
    tData,
    tWidth,
    tHeight,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  textureAnimation.needsUpdate = true;

  const vertices = [];
  const color = [];
  const reference = [];
  const seeds = [];
  const indices = [];
  const totalVertices = birdGeo.getAttribute("position").count * 3 * BIRDS;

  for (let i = 0; i < totalVertices; i++) {
    const bIndex = i % (birdGeo.getAttribute("position").count * 3);
    vertices.push(birdGeo.getAttribute("position").array[bIndex]);
    color.push(birdGeo.getAttribute("color")?.array[bIndex] ?? 0);
  }

  let r = Math.random();
  for (let i = 0; i < birdGeo.getAttribute("position").count * BIRDS; i++) {
    const bIndex = i % birdGeo.getAttribute("position").count;
    const bird = Math.floor(i / birdGeo.getAttribute("position").count);
    if (bIndex == 0) r = Math.random();
    const j = ~~bird;
    const x = (j % WIDTH) / WIDTH;
    const y = ~~(j / WIDTH) / WIDTH;
    reference.push(x, y, bIndex / tWidth, durationAnimation / tHeight);
    seeds.push(bird, r, Math.random(), Math.random());
  }

  for (let i = 0; i < birdGeo.index.array.length * BIRDS; i++) {
    const offset =
      Math.floor(i / birdGeo.index.array.length) *
      birdGeo.getAttribute("position").count;
    indices.push(birdGeo.index.array[i % birdGeo.index.array.length] + offset);
  }

  BirdGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(vertices), 3)
  );
  BirdGeometry.setAttribute(
    "birdColor",
    new THREE.BufferAttribute(new Float32Array(color), 3)
  );
  BirdGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(color), 3)
  );
  BirdGeometry.setAttribute(
    "reference",
    new THREE.BufferAttribute(new Float32Array(reference), 4)
  );
  BirdGeometry.setAttribute(
    "seeds",
    new THREE.BufferAttribute(new Float32Array(seeds), 4)
  );

  BirdGeometry.setIndex(indices);

  Promise.all([
    fetch("bird-position-shader.glsl")
      .then((r) => r.text())
      .then((s) => (birdPositionShader = s)),
    fetch("bird-velocity-shader.glsl")
      .then((r) => r.text())
      .then((s) => (birdVelocityShader = s)),
    fetch("vertex-shader.glsl")
      .then((r) => r.text())
      .then((s) => (vertexShader = s)),
  ]).then(init);
});

function init() {
  container = document.createElement("div");
  document.body.appendChild(container);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    1,
    3000
  );
  camera.position.z = 350;

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#ffffff");
  scene.fog = new THREE.Fog("#ffffff", 100, 1000);

  const hemiLight = new THREE.HemisphereLight("#8888ff", 0xffffff, 4.5);
  hemiLight.color.setHSL(0.6, 1, 0.6, THREE.SRGBColorSpace);
  hemiLight.groundColor.setHSL(0.095, 1, 0.75, THREE.SRGBColorSpace);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0x00ced1, 2.0);
  dirLight.color.setHSL(0.1, 1, 0.95, THREE.SRGBColorSpace);
  dirLight.position.set(-1, 1.75, 1);
  dirLight.position.multiplyScalar(30);
  scene.add(dirLight);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(animate);
  container.appendChild(renderer.domElement);

  initComputeRenderer();

  stats = new Stats();
  container.appendChild(stats.dom);

  window.addEventListener("resize", onWindowResize);

  const gui = new GUI();

  const effectController = {
    separation: 20.0,
    alignment: 20.0,
    cohesion: 20.0,
    size: 0.2,
    count: Math.floor(BIRDS / 4),
  };

  const valuesChanger = function () {
    velocityUniforms["separationDistance"].value = effectController.separation;
    velocityUniforms["alignmentDistance"].value = effectController.alignment;
    velocityUniforms["cohesionDistance"].value = effectController.cohesion;
    if (materialShader)
      materialShader.uniforms["size"].value = effectController.size;
    BirdGeometry.setDrawRange(0, indicesPerBird * effectController.count);
  };

  valuesChanger();

  gui
    .add(effectController, "separation", 0.0, 100.0, 1.0)
    .onChange(valuesChanger);
  gui
    .add(effectController, "alignment", 0.0, 100, 0.001)
    .onChange(valuesChanger);
  gui
    .add(effectController, "cohesion", 0.0, 100, 0.025)
    .onChange(valuesChanger);
  gui.add(effectController, "size", 0, 1, 0.01).onChange(valuesChanger);
  gui.add(effectController, "count", 0, BIRDS, 1).onChange(valuesChanger);
  gui.close();

  initBirds(effectController);
}

function animate() {
  render();
  stats.update();
}

function render() {
  const now = performance.now();
  let delta = (now - last) / 1000;

  if (delta > 1) delta = 1; // safety cap on large deltas
  last = now;

  positionUniforms["time"].value = now;
  positionUniforms["delta"].value = delta;
  velocityUniforms["time"].value = now;
  velocityUniforms["delta"].value = delta;
  if (materialShader) materialShader.uniforms["time"].value = now / 1000;
  if (materialShader) materialShader.uniforms["delta"].value = delta;

  gpuCompute.compute();

  if (materialShader)
    materialShader.uniforms["texturePosition"].value =
      gpuCompute.getCurrentRenderTarget(positionVariable).texture;
  if (materialShader)
    materialShader.uniforms["textureVelocity"].value =
      gpuCompute.getCurrentRenderTarget(velocityVariable).texture;

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
}

function initComputeRenderer() {
  gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);

  const dtPosition = gpuCompute.createTexture();
  const dtVelocity = gpuCompute.createTexture();
  fillPositionTexture(dtPosition);
  fillVelocityTexture(dtVelocity);

  velocityVariable = gpuCompute.addVariable(
    "textureVelocity",
    birdVelocityShader,
    dtVelocity
  );
  positionVariable = gpuCompute.addVariable(
    "texturePosition",
    birdPositionShader,
    dtPosition
  );

  gpuCompute.setVariableDependencies(velocityVariable, [
    positionVariable,
    velocityVariable,
  ]);
  gpuCompute.setVariableDependencies(positionVariable, [
    positionVariable,
    velocityVariable,
  ]);

  positionUniforms = positionVariable.material.uniforms;
  velocityUniforms = velocityVariable.material.uniforms;

  positionUniforms["time"] = { value: 0.0 };
  positionUniforms["delta"] = { value: 0.0 };
  velocityUniforms["time"] = { value: 1.0 };
  velocityUniforms["delta"] = { value: 0.0 };
  velocityUniforms["testing"] = { value: 1.0 };
  velocityUniforms["separationDistance"] = { value: 1.0 };
  velocityUniforms["alignmentDistance"] = { value: 1.0 };
  velocityUniforms["cohesionDistance"] = { value: 1.0 };
  velocityVariable.material.defines.BOUNDS = BOUNDS.toFixed(2);

  velocityVariable.wrapS = THREE.RepeatWrapping;
  velocityVariable.wrapT = THREE.RepeatWrapping;
  positionVariable.wrapS = THREE.RepeatWrapping;
  positionVariable.wrapT = THREE.RepeatWrapping;

  const error = gpuCompute.init();

  if (error !== null) {
    console.error(error);
  }
}

function initBirds(effectController: EffectController) {
  const geometry = BirdGeometry;

  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.texturePosition = { value: null };
    shader.uniforms.textureVelocity = { value: null };
    shader.uniforms.textureAnimation = { value: textureAnimation };
    shader.uniforms.time = { value: 1.0 };
    shader.uniforms.size = { value: effectController.size };
    shader.uniforms.delta = { value: 0.0 };

    shader.vertexShader = vertexShader;
    materialShader = shader;
  };

  birdMesh = new THREE.Mesh(geometry, m);
  birdMesh.rotation.y = Math.PI / 2;

  birdMesh.castShadow = true;
  birdMesh.receiveShadow = true;

  scene.add(birdMesh);
}

function fillPositionTexture(texture: THREE.DataTexture) {
  const theArray = texture.image.data;

  for (let k = 0, kl = theArray.length; k < kl; k += 4) {
    const x = Math.random() * BOUNDS - BOUNDS_HALF;
    const y = Math.random() * BOUNDS - BOUNDS_HALF;
    const z = Math.random() * BOUNDS - BOUNDS_HALF;

    theArray[k + 0] = x;
    theArray[k + 1] = y;
    theArray[k + 2] = z;
    theArray[k + 3] = 1;
  }
}

function fillVelocityTexture(texture: THREE.DataTexture) {
  const theArray = texture.image.data;

  for (let k = 0, kl = theArray.length; k < kl; k += 4) {
    const x = Math.random() - 0.5;
    const y = Math.random() - 0.5;
    const z = Math.random() - 0.5;

    theArray[k + 0] = x * 10;
    theArray[k + 1] = y * 10;
    theArray[k + 2] = z * 10;
    theArray[k + 3] = 1;
  }
}
