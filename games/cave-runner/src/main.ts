import { WebGLRenderer, PerspectiveCamera } from 'three';

import RunningScene from './scenes/RunningScene';
import MainMenuScene from './scenes/MainMenuScene';
import CharacterSelectionScene from './scenes/CharacterSelectionScene';

const width = window.innerWidth;
const height = window.innerHeight;

const renderer = new WebGLRenderer({
  canvas: document.getElementById('app') as HTMLCanvasElement,
  antialias: true,
  precision: 'mediump',
});

renderer.setSize(width, height);

let currentScene:MainMenuScene | RunningScene | CharacterSelectionScene;
let resolveGameAssetsReady: () => void = () => {};
const gameAssetsReadyPromise = new Promise<void>((resolve) => {
  resolveGameAssetsReady = resolve;
});

const mainCamera = new PerspectiveCamera(60, width / height, 0.1, 1000);

function onWindowResize() {
  mainCamera.aspect = window.innerWidth / window.innerHeight;
  mainCamera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', onWindowResize);

const runningScene = new RunningScene();
const mainMenuScene = new MainMenuScene();
const characterSelectionScene = new CharacterSelectionScene();

const switchToRunningScene = () => {
  // `currentScene` is still unset when __oddzoneStart() fires during module
  // evaluation (the arena can call it before main() assigns the menu). The old
  // version called currentScene.hide() unconditionally, threw a TypeError, and
  // took the WHOLE module down with it -- which is why window.__oddzoneStart /
  // __oddzoneEnd / __oddzoneReadScore never got defined and the parent arena
  // could not read or submit a Cave Runner score at all.
  if (currentScene && typeof currentScene.hide === 'function') currentScene.hide();
  currentScene = runningScene;
  currentScene.initialize();
};

// ── INSTANT TAP-TO-START ─────────────────────────────────────────────────
// OddZone opens this game straight into a run: no Play / Characters / About
// menu to get through first. The arena calls __oddzoneStart() when the player
// taps, but a tap on the canvas must work on its own too -- otherwise the
// frame sits on an invisible menu until the host happens to poke it.
let oddzoneRunActive = false;

const startRunNow = async () => {
  await gameAssetsReadyPromise;
  oddzoneRunActive = true;
  hideStartMenus();
  switchToRunningScene();
  runningScene.startOddZoneMatch();
};

// The menus are hidden rather than deleted: their DOM nodes are wired up
// below, and removing them would throw on the next initialize().
const hideStartMenus = () => {
  const menuButtons = document.getElementById('main-menu-buttons');
  if (menuButtons) menuButtons.style.display = 'none';
  const characterContainer = document.getElementById('character-selection-container');
  if (characterContainer) characterContainer.style.display = 'none';
  document.querySelectorAll('.home-menu, .auth-button, #sign-out-button, #greetings, #score-board-button')
    .forEach((element) => {
      (element as HTMLElement).style.display = 'none';
    });
};

// A tap anywhere on the field starts the run. Bound once, in the capture
// phase, so the game's own gesture handlers cannot swallow the first touch.
const field = document.getElementById('app');
const startOnTap = (event: Event) => {
  if (oddzoneRunActive) return;
  // Buttons of the (hidden) menus and modals are not "the field".
  const target = event.target as HTMLElement | null;
  if (target && target.closest('button, .modal, .loading-container')) return;
  void startRunNow();
};
field?.addEventListener('pointerdown', startOnTap, true);
field?.addEventListener('touchstart', startOnTap, { capture: true, passive: true });

(window as any).__oddzoneReadScore = () => runningScene.getOddZoneScore();
(window as any).__oddzoneStart = async () => {
  await startRunNow();
};
(window as any).__oddzoneEnd = () => runningScene.endOddZoneMatch();

const switchToMainMenuScene = () => {
  if (currentScene && typeof currentScene.hide === 'function') currentScene.hide();
  currentScene = mainMenuScene;
  currentScene.initialize();
};

const switchToCharacterSelectionScene = () => {
  if (currentScene && typeof currentScene.hide === 'function') currentScene.hide();
  currentScene = characterSelectionScene;
  currentScene.initialize();
};
(document.getElementById('play-game-button')as HTMLInputElement).onclick = () => {
  void startRunNow();
};
(document.querySelector('#quit-button')as HTMLInputElement).onclick = () => {
  (document.getElementById('game-over-modal')as HTMLInputElement).style.display = 'none';
  // "Quit" no longer parks the player on a dead menu: the run reports and
  // restarts immediately, exactly like a crash.
  if (oddzoneRunActive) runningScene.startOddZoneMatch();
  else switchToMainMenuScene();
};

(document.querySelector('#game-over-quit-button')as HTMLInputElement).onclick = () => {
  (document.getElementById('game-over-modal')as HTMLInputElement).style.display = 'none';
  if (oddzoneRunActive) runningScene.startOddZoneMatch();
  else switchToMainMenuScene();
};

currentScene = mainMenuScene;
const render = () => {
  currentScene.update();
  renderer.render(currentScene, mainCamera);
  requestAnimationFrame(render);
};

(document.querySelector('#Characters-selection-button')as HTMLInputElement).onclick = () => {
  switchToCharacterSelectionScene();
};
(document.querySelector('.home-menu')as HTMLInputElement).onclick = () => {
  switchToMainMenuScene();
};

const main = async () => {
  await runningScene.load();
  await mainMenuScene.load();
  await characterSelectionScene.load();
  (document.querySelector('.loading-container') as HTMLInputElement).style.display = 'none';
  // Boot STRAIGHT into the run instead of the Play/Characters/About menu:
  // hide the menus, show the field and start the clock. Nothing is waiting
  // for a button press.
  hideStartMenus();
  currentScene = mainMenuScene;
  currentScene.initialize();
  render();
  resolveGameAssetsReady();
  void startRunNow();
};

main();
