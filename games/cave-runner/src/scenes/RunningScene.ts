/* eslint-disable linebreak-style */
import {
  Scene, DirectionalLight, AmbientLight, Object3D, AnimationMixer, AnimationAction, Clock,
  Box3, Group, BoxGeometry, MeshPhongMaterial, Mesh, Vector3,
} from 'three';

import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import Toastify from 'toastify-js';
import TWEEN, { Tween } from '@tweenjs/tween.js';
import allCharacters, { normalizeCharacterAssets } from '../allCharacters';

import { IallGameCharacters } from '../types';

// Runner movement constants, shared by the keyboard and the touch handlers.
const GROUND_Y = -35;          // standing height on the track
const JUMP_HEIGHT = 30;        // how far the hop lifts the runner
const JUMP_UP_MS = 280;        // rise time
const JUMP_DOWN_MS = 360;      // fall time
const SLIDE_DROP = 6;          // how low the slide crouches
const SLIDE_MS = 800;          // how long a slide lasts
const SWIPE_MIN_DISTANCE = 24; // px of travel before a touch counts as a swipe

export default class RunningScene extends Scene {
  private fbxLoader = new FBXLoader();

  private woodenCave = new Object3D();

  private player = new Object3D();

  private animationMixer!: AnimationMixer;

  private runningAnimation!: AnimationAction;

  private clock = new Clock();

  private delta = 0;

  private woodenCaveClone = new Object3D();

  private caveSize = 0;

  private speed = 220;

  private currentAnimation!: AnimationAction;

  private jumpingAnimation!: AnimationAction;

  private isJumping = false;

  private jumpingUp!: Tween<any>;

  private jumpingDown!: Tween<any>;

  private isSliding = false;

  private slidingAnimation !: AnimationAction;

  private sliderTimeout!: ReturnType<typeof setTimeout>;

  private animationFinishedHandler: (() => void) | null = null;

  private barrelObject = new Object3D();

  private boxObject = new Object3D();

  private spikeObject = new Object3D();

  private obstacleArray: Group[] = [];

  private currentObstacleOne = new Group();

  private currentObstacleTwo = new Group();

  private playerBox = new Mesh(new BoxGeometry(), new MeshPhongMaterial({ color: 0x0000ff }));

  private playerBoxCollider = new Box3(new Vector3(), new Vector3());

  private obstacleBox = new Box3(new Vector3(), new Vector3());

  private obstacleBox2 = new Box3(new Vector3(), new Vector3());

  private coinObject = new Object3D();

  private coinsArray: Group[] = [];

  private activeCoinsGroup = new Group();

  private coinBox = new Box3(new Vector3(), new Vector3());

  private scores = 0;

  private coins = 0;

  private isGamePaused = false;

  private isGameOver = false;

  private stumbleAnimation!: AnimationAction;

  private isPlayerHeadStart = false;

  private touchstartX = 0;

  private touchendX = 0;

  private touchstartY = 0;

  private touchendY = 0;

  private touchPointerId: number | null = null;

  private xbot = new Object3D();

  private xbotRunningAnimation = new Object3D();

  private xbotJumpingAnimation = new Object3D();

  private xbotSlidingAnimation = new Object3D();

  private xbotStumbleAnimation = new Object3D();

  private jolleen = new Object3D();

  private jolleenRunningAnimation = new Object3D();

  private jolleenJumpingAnimation = new Object3D();

  private jolleenSlidingAnimation = new Object3D();

  private jolleenStumbleAnimation = new Object3D();

  private peasantGirl = new Object3D();

  private peasantGirlRunningAnimation = new Object3D();

  private peasantGirlJumpingAnimation = new Object3D();

  private peasantGirlSlidingAnimation = new Object3D();

  private peasantGirlStumbleAnimation = new Object3D();

  private allGameCharacters: IallGameCharacters[] = [];

  private charactersContainer: Object3D[] = [];

  private runningAnimationsContainer: Object3D[] = [];

  private jumpingAnimationsContainer: Object3D[] = [];

  private slidingAnimationsContainer: Object3D[] = [];

  private stumbleAnimationsContainer: Object3D[] = [];

  private activePlayerIndex = 0;

  async load() {
    const ambient = new AmbientLight(0xFFFFFF, 2.5);
    this.add(ambient);

    const light = new DirectionalLight(0xFFFFFF, 2.5);

    light.position.set(0, 40, -10);
    this.add(light);

    this.woodenCave = await this.fbxLoader.loadAsync('./assets/models/wooden-cave.fbx');
    this.woodenCave.position.set(0, 0, -500);
    this.woodenCave.scale.set(0.055, 0.055, 0.055);
    this.add(this.woodenCave);
    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '5%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 5;

    this.woodenCaveClone = this.woodenCave.clone();
    const caveBox = new Box3().setFromObject(this.woodenCave);
    this.caveSize = caveBox.max.z - caveBox.min.z - 1;
    this.woodenCaveClone.position.z = this.woodenCave.position.z + this.caveSize;
    this.add(this.woodenCaveClone);

    this.barrelObject = await this.fbxLoader.loadAsync('./assets/models/barrel.fbx');
    this.boxObject = await this.fbxLoader.loadAsync('./assets/models/box.fbx');
    this.spikeObject = await this.fbxLoader.loadAsync('./assets/models/spike.fbx');
    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '10%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 10;
    this.createLeftJumpObstacle();

    this.createLeftJumpObstacle();

    this.createCenterJumpObstacle();

    this.createRightJumpObstacle();

    this.createRightCenterObstacle();

    this.createLeftSlideObstacle();

    this.createCenterRightObstacle();

    this.createLeftCenterObstacle();

    this.createLeftRightObstacle();

    this.createCenterSlideObstacle();

    this.createRightSlideObstacle();

    this.coinObject = await this.fbxLoader.loadAsync('./assets/models/coin.fbx');
    this.coinObject.rotation.set(90 * (Math.PI / 180), 0, 150 * (Math.PI / 180));
    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '12%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 12;
    this.generateLeftCenterRightCoins();

    this.generateLeftSideCoin();

    this.generateLeftandCenterCoins();

    this.generateCenterRightCoins();

    this.generateRightCoins();

    const gestureZone = (document.getElementById('app') as HTMLInputElement);
    if (gestureZone) {
      // Registered ONCE, outside the game-over/paused guard: the old code only
      // attached these while a run was live, so after the first death (or
      // pause) the swipe controls were gone for every later run. Each handler
      // checks the live state itself instead.
      gestureZone.addEventListener('touchstart', (event) => {
        this.touchstartX = event.changedTouches[0].screenX;
        this.touchstartY = event.changedTouches[0].screenY;
        this.touchendX = this.touchstartX;
        this.touchendY = this.touchstartY;
      }, { passive: true });

      gestureZone.addEventListener('touchend', (event) => {
        if (this.isGameOver || this.isGamePaused) return;
        this.touchendX = event.changedTouches[0].screenX;
        this.touchendY = event.changedTouches[0].screenY;
        this.handleTouch();
      }, false);

      // Pointer swipes for touchscreens that deliver pointer events only.
      gestureZone.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') return;
        this.touchPointerId = event.pointerId;
        this.touchstartX = event.clientX;
        this.touchstartY = event.clientY;
        this.touchendX = event.clientX;
        this.touchendY = event.clientY;
      }, { passive: true });
      gestureZone.addEventListener('pointerup', (event) => {
        if (event.pointerType === 'mouse' || event.pointerId !== this.touchPointerId) return;
        if (this.isGameOver || this.isGamePaused) return;
        // The touch* handlers already reacted to this gesture on most devices.
        if (event.clientX === this.touchendX && event.clientY === this.touchendY
          && (this.touchendX !== this.touchstartX || this.touchendY !== this.touchstartY)) return;
        this.touchendX = event.clientX;
        this.touchendY = event.clientY;
        this.handleTouch();
      }, false);
    }

    if (!JSON.parse(localStorage.getItem('allGameCharacters')!)) {
      localStorage.setItem('allGameCharacters', JSON.stringify(allCharacters));
    }

    this.allGameCharacters = (JSON.parse(localStorage.getItem('allGameCharacters')!));

    this.xbot = await this.fbxLoader.loadAsync(this.allGameCharacters[0].model);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '13%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 13;

    this.xbotRunningAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[0]
      .runAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '14%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 14;

    this.xbotJumpingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[0]
      .jumpAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '15%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 15;

    this.xbotSlidingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[0]
      .slideAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '16%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 16;

    this.xbotStumbleAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[0]
      .stumbleAnimation);
    this.xbotSlidingAnimation.animations[0].tracks.shift();

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '17%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 17;

    this.jolleen = await this.fbxLoader.loadAsync(this.allGameCharacters[1].model);
    this.jolleenRunningAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[1]
      .runAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '18%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 18;

    this.jolleenJumpingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[1]
      .jumpAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '19%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 19;

    this.jolleenSlidingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[1]
      .slideAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '20%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 20;

    this.jolleenStumbleAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[1]
      .stumbleAnimation);
    this.jolleenSlidingAnimation.animations[0].tracks.shift();

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '21%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 21;

    this.peasantGirl = await this.fbxLoader.loadAsync(this.allGameCharacters[2].model);
    this.peasantGirlRunningAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[2]
      .runAnimation);
    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '22%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 22;

    this.peasantGirlJumpingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[2]
      .jumpAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '23%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 23;

    this.peasantGirlSlidingAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[2]
      .slideAnimation);

    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '24%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 24;

    this.peasantGirlStumbleAnimation = await this.fbxLoader.loadAsync(this.allGameCharacters[2]
      .stumbleAnimation);
    this.peasantGirlSlidingAnimation.animations[0].tracks.shift();
    (document.querySelector('.loading-percentage') as HTMLInputElement).innerHTML = '25%';
    (document.querySelector('#loading-bar') as HTMLProgressElement).value = 25;
    this.xbot.visible = false;
    this.jolleen.visible = false;
    this.peasantGirl.visible = false;

    this.charactersContainer.push(this.xbot, this.jolleen, this.peasantGirl);

    this.add(this.xbot);
    this.add(this.jolleen);
    this.add(this.peasantGirl);

    this.runningAnimationsContainer.push(
      this.xbotRunningAnimation,
      this.jolleenRunningAnimation,
      this.peasantGirlRunningAnimation,
    );
    this.jumpingAnimationsContainer.push(
      this.xbotJumpingAnimation,
      this.jolleenJumpingAnimation,
      this.peasantGirlJumpingAnimation,
    );
    this.slidingAnimationsContainer.push(
      this.xbotSlidingAnimation,
      this.jolleenSlidingAnimation,
      this.peasantGirlSlidingAnimation,
    );
    this.stumbleAnimationsContainer.push(
      this.xbotStumbleAnimation,
      this.jolleenStumbleAnimation,
      this.peasantGirlStumbleAnimation,
    );

    document.onkeydown = (e) => {
      if (this.isGameOver || this.isGamePaused) return;
      const key = e.key;
      const code = e.code;
      if (key === 'ArrowLeft' || key === 'a' || key === 'A' || code === 'KeyA') {
        e.preventDefault();
        this.moveLeft();
      } else if (key === 'ArrowRight' || key === 'd' || key === 'D' || code === 'KeyD') {
        e.preventDefault();
        this.moveRight();
      } else if (key === 'ArrowUp' || key === 'w' || key === 'W' || code === 'KeyW'
        || code === 'Space' || key === ' ') {
        // Space is BOTH the jump button and the pause key on the old build:
        // pausing mid-hop is exactly what made jumps vanish. Space jumps now;
        // P / Escape pauses.
        e.preventDefault();
        this.jump();
      } else if (key === 'ArrowDown' || key === 's' || key === 'S' || code === 'KeyS') {
        e.preventDefault();
        this.slide();
      } else if (key === 'p' || key === 'P' || key === 'Escape') {
        e.preventDefault();
        this.pauseAndResumeGame();
      }
    };
  }

  initialize() {
    const savedCharacters = JSON.parse(localStorage.getItem('allGameCharacters') || 'null');
    this.allGameCharacters = normalizeCharacterAssets(
      Array.isArray(savedCharacters) && savedCharacters.length ? savedCharacters : allCharacters,
    );
    localStorage.setItem('allGameCharacters', JSON.stringify(this.allGameCharacters));

    this.activePlayerIndex = this.allGameCharacters
      .findIndex((character) => character.isActive === true);
    if (this.activePlayerIndex < 0) this.activePlayerIndex = 0;

    this.player = this.charactersContainer[this.activePlayerIndex];
    this.player.position.z = -110;
    this.player.position.y = GROUND_Y;
    this.player.position.x = 0;
    this.player.scale.set(0.1, 0.1, 0.1);
    this.player.rotation.y = 180 * (Math.PI / 180);
    this.player.visible = true;

    this.playerBox.visible = false;
    this.playerBox.scale.set(50, 200, 20);
    this.playerBox.position.set(0, 90, 0);
    this.player.add(this.playerBox);

    this.animationMixer = new AnimationMixer(this.player);

    const runningAnimationObject = this.runningAnimationsContainer[this.activePlayerIndex];

    this.runningAnimation = this.animationMixer.clipAction(runningAnimationObject.animations[0]);
    this.currentAnimation = this.runningAnimation;
    this.currentAnimation.reset();
    this.currentAnimation.play();

    const jumpingAnimationObject = this.jumpingAnimationsContainer[this.activePlayerIndex];
    this.jumpingAnimation = this.animationMixer.clipAction(jumpingAnimationObject.animations[0]);

    const slidingAnimationObject = this.slidingAnimationsContainer[this.activePlayerIndex];
    this.slidingAnimation = this.animationMixer.clipAction(slidingAnimationObject.animations[0]);

    const stumblingAnimationObject = this.stumbleAnimationsContainer[this.activePlayerIndex];
    this.stumbleAnimation = this.animationMixer.clipAction(stumblingAnimationObject.animations[0]);

    (document.querySelector('.scores-container') as HTMLInputElement).style.display = 'block';

    (document.querySelector('.coins-container') as HTMLInputElement).style.display = 'block';

    (document.querySelector('.pause-button') as HTMLInputElement).style.display = 'block';

    (document.querySelector('.pause-button') as HTMLInputElement).onclick = () => {
      this.pauseAndResumeGame();
    };

    (document.getElementById('resume-button') as HTMLInputElement).onclick = () => {
      this.pauseAndResumeGame();
    };
    (document.getElementById('restart-button') as HTMLInputElement).onclick = () => {
      this.restartGame();
    };
    setTimeout(() => {
      this.isPlayerHeadStart = true;
    }, 3000);

    if (!this.visible) {
      this.visible = true;
    }

    if (!this.clock.running) {
      /*       this.currentAnimation = this.runningAnimation;
      this.currentAnimation.reset();
      this.currentAnimation.play(); */
      this.clock.start();
      this.speed = 220;
      this.player.position.x = 0;
    }
  }

  update() {
    if (this.isGameOver || this.isGamePaused) return;

    if (this.animationMixer) {
      this.delta = this.clock.getDelta();
      this.animationMixer.update(this.delta);
    }
    this.woodenCave.position.z += this.speed * this.delta;
    this.woodenCaveClone.position.z += this.speed * this.delta;

    if (this.woodenCave.position.z > 600) {
      this.woodenCave.position.z = this.woodenCaveClone.position.z - this.caveSize;
    }

    if (this.woodenCaveClone.position.z > 600) {
      this.woodenCaveClone.position.z = this.woodenCave.position.z - this.caveSize;
    }
    TWEEN.update();

    this.playerBoxCollider.setFromObject(this.playerBox);

    this.detectCollisionWithCoins();

    this.detectCollisionWithObstacles();

    this.scores += Math.round(this.speed * this.delta);
    (document.querySelector('.scores-count') as HTMLInputElement).innerHTML = this.scores.toString();

    if (this.isPlayerHeadStart) {
      this.spawnObstacle();
      this.spawnCoin();
    }

    if (!this.isGameOver && this.speed < 400 && !this.isGamePaused) {
      this.speed += 0.06;
    }
  }

  getOddZoneScore() {
    return this.scores;
  }

  // The arena's Tap-to-Start. restartGame() is the only reset path that puts
  // the scene back into a playable state (clock running, speed restored,
  // paused/game-over cleared, counters zeroed), but it is private and was
  // previously reachable only through the in-game quit/retry buttons. Exposing
  // it here is what makes __oddzoneStart() actually start a live run.
  startOddZoneMatch() {
    this.restartGame();
  }

  endOddZoneMatch() {
    this.isGameOver = true;
    this.isGamePaused = true;
    this.isPlayerHeadStart = false;
    this.speed = 0;
    this.clock.stop();
    (document.querySelector('.pause-button') as HTMLInputElement).style.display = 'none';
    (document.querySelector('.scores-count') as HTMLInputElement).textContent = this.scores.toString();
    (document.querySelector('#current-score') as HTMLInputElement).textContent = this.scores.toString();
    (document.getElementById('game-over-modal') as HTMLInputElement).style.display = 'block';
  }

  hide() {
    (document.querySelector('.disable-touch') as HTMLInputElement).style.display = 'none';

    this.isGameOver = false;

    this.coins = 0;

    this.scores = 0;

    (document.getElementById('game-paused-modal') as HTMLInputElement).style.display = 'none';

    (document.querySelector('.scores-container') as HTMLInputElement).style.display = 'none';

    (document.querySelector('.coins-container') as HTMLInputElement).style.display = 'none';

    (document.querySelector('.pause-button') as HTMLInputElement).style.display = 'none';

    this.visible = false;

    this.currentObstacleOne.position.z = -1200;
    this.currentObstacleTwo.position.z = -1500;

    this.activeCoinsGroup.position.z = -1200;
    this.currentAnimation.stop();
    this.player.visible = false;
    this.clock.stop();
    this.player.rotation.x = 0;
    // A rack left mid-hop/mid-slide must not carry that pose (or a locked
    // flag) into the next run.
    clearTimeout(this.sliderTimeout);
    this.isJumping = false;
    this.isSliding = false;
    this.isGamePaused = false;
    this.player.position.y = GROUND_Y;
  }

  private gameOver() {
    this.isGameOver = true;
    this.speed = 0;
    (document.querySelector('.pause-button') as HTMLInputElement).style.display = 'none';
    setTimeout(() => {
      this.clock.stop();
      (document.getElementById('game-over-modal') as HTMLInputElement).style.display = 'block';
      (document.querySelector('#current-score') as HTMLInputElement).innerHTML = this.scores.toString();
      (document.querySelector('#current-coins') as HTMLInputElement).innerHTML = this.coins.toString();

      this.stumbleAnimation.reset();
      this.player.rotation.x = (90 * (Math.PI / 180));
    }, 3000);
    this.stumbleAnimation.reset();
    this.stumbleAnimation.setLoop(1, 1);
    this.stumbleAnimation.clampWhenFinished = true;

    this.currentAnimation.crossFadeTo(this.stumbleAnimation, 0.1, false).play();
    this.currentAnimation = this.stumbleAnimation;
    this.currentObstacleOne.position.z -= 5;
    this.currentObstacleTwo.position.z -= 5;
    this.isPlayerHeadStart = false;
    (document.querySelector('.disable-touch') as HTMLInputElement).style.display = 'block';
    this.saveCoins();
    this.saveHighScore();
  }

  private restartGame() {
    (document.getElementById('game-over-modal') as HTMLInputElement).style.display = 'none';
    // Clear any hop/slide left over from the lost run, so the new run starts
    // on the ground with both actions available.
    clearTimeout(this.sliderTimeout);
    this.jumpingUp?.stop();
    this.jumpingDown?.stop();
    this.isJumping = false;
    this.isSliding = false;
    this.player.position.y = GROUND_Y;
    this.currentObstacleOne.position.z = -1200;
    this.currentObstacleTwo.position.z = -1500;
    this.activeCoinsGroup.position.z = -1800;
    this.clock.start();
    this.speed = 220;
    this.coins = 0;
    this.scores = 0;
    (document.querySelector('.coins-count') as HTMLInputElement).innerHTML = '0';
    this.runningAnimation.reset();
    this.currentAnimation.crossFadeTo(this.runningAnimation, 0, false).play();
    this.player.rotation.x = 0;
    this.isGameOver = false;
    this.isGamePaused = false;
    this.currentAnimation = this.runningAnimation;
    (document.querySelector('.pause-button') as HTMLInputElement).style.display = 'block';
    this.player.position.x = 0;
    setTimeout(() => {
      this.isPlayerHeadStart = true;
    }, 3000);
    (document.querySelector('.disable-touch') as HTMLInputElement).style.display = 'none';
  }

  private detectCollisionWithObstacles() {
    for (let i = 0; i < this.currentObstacleOne.children.length; i += 1) {
      this.obstacleBox.setFromObject(this.currentObstacleOne.children[i]);
      if (this.playerBoxCollider.intersectsBox(this.obstacleBox)) {
        this.gameOver();
      }
    }
    for (let i = 0; i < this.currentObstacleTwo.children.length; i += 1) {
      this.obstacleBox2.setFromObject(this.currentObstacleTwo.children[i]);

      if (this.playerBoxCollider.intersectsBox(this.obstacleBox2)) {
        this.gameOver();
      }
    }
  }

  private moveLeft() {
    if (this.player.position.x !== -18) {
      const tweenLeft = new TWEEN.Tween(this.player.position)
        .to({ x: this.player.position.x - 18 }, 200)
        .easing(TWEEN.Easing.Quadratic.Out)
        .onUpdate(() => {
          this.player.rotation.y = -140 * (Math.PI / 180);
          if (this.player.position.x <= -18) {
            this.player.position.x = -18;
          }
        })
        .onComplete(() => {
          this.player.rotation.y = 180 * (Math.PI / 180);
        });
      tweenLeft.start();
    }
  }

  private moveRight() {
    if (this.player.position.x !== 18) {
      this.player.rotation.y = 140 * (Math.PI / 180);
      const tweenRight = new Tween(this.player.position)
        .to({ x: this.player.position.x + 18 }, 200)
        .easing(TWEEN.Easing.Quadratic.Out)
        .onUpdate(() => {
          if (this.player.position.x >= 18) {
            this.player.position.x = 18;
          }
        })
        .onComplete(() => {
          this.player.rotation.y = 180 * (Math.PI / 180);
        });
      tweenRight.start();
    }
  }

  private jump() {
    if (this.isGameOver || this.isGamePaused) return;
    if (this.isJumping) return;
    if (this.isSliding) {
      // A slide in progress is cancelled cleanly before the hop starts.
      this.endSlide();
    }
    this.isJumping = true;
    // The jump always starts from the ground, never from a half-applied
    // offset -- that drift is what used to leave the runner floating and
    // unable to clear (or pass under) the next obstacle.
    this.player.position.y = GROUND_Y;
    this.currentAnimation.stop();
    this.currentAnimation = this.jumpingAnimation;
    this.currentAnimation.reset();
    this.currentAnimation.setLoop(1, 1);
    this.currentAnimation.clampWhenFinished = true;
    this.currentAnimation.play();
    this.refreshFinishedListener();

    // Absolute targets, and only one tween alive per half of the hop: the old
    // code chained a relative `+= 20` with a `-= 20` and re-registered its
    // onComplete every jump, so a fast second jump moved the runner twice.
    this.jumpingUp = new Tween(this.player.position)
      .to({ y: GROUND_Y + JUMP_HEIGHT }, JUMP_UP_MS)
      .easing(TWEEN.Easing.Quadratic.Out);
    this.jumpingDown = new Tween(this.player.position)
      .to({ y: GROUND_Y }, JUMP_DOWN_MS)
      .easing(TWEEN.Easing.Quadratic.In)
      .onComplete(() => {
        this.player.position.y = GROUND_Y;
        this.isJumping = false;
      });
    this.jumpingUp.chain(this.jumpingDown);
    this.jumpingUp.start();
  }

  private slide() {
    if (this.isGameOver || this.isGamePaused) return;
    // Re-triggering a slide simply extends it, so holding/pressing again is
    // never ignored and the runner can never get stuck in an old slide.
    if (this.isJumping) {
      this.cancelJump();
    }
    clearTimeout(this.sliderTimeout);
    if (!this.isSliding) {
      this.isSliding = true;
      this.player.position.y = GROUND_Y - SLIDE_DROP;
      this.currentAnimation.stop();
      this.slidingAnimation.reset();
      this.currentAnimation = this.slidingAnimation;
      this.slidingAnimation.setLoop(1, 1);
      this.slidingAnimation.clampWhenFinished = true;
      this.slidingAnimation.play();
      this.refreshFinishedListener();
    }
    this.sliderTimeout = setTimeout(() => this.endSlide(), SLIDE_MS);
  }

  /** Finish a slide: back to the running pose and standing height. */
  private endSlide() {
    clearTimeout(this.sliderTimeout);
    if (!this.isSliding) return;
    this.isSliding = false;
    this.player.position.y = GROUND_Y;
    if (!this.isJumping && !this.isGameOver) {
      this.currentAnimation.stop();
      this.runningAnimation.reset();
      this.runningAnimation.play();
      this.currentAnimation = this.runningAnimation;
    }
  }

  /** Abort a jump mid-air (a slide interrupts it) without leaving it chained. */
  private cancelJump() {
    this.jumpingUp.stop();
    this.jumpingDown.stop();
    this.isJumping = false;
    this.player.position.y = GROUND_Y;
  }

  /**
   * One animation 'finished' listener for the current mixer.
   *
   * The old jump() added a NEW listener on every jump and never removed it, so
   * after a few hops the mixer cross-faded the running pose several times per
   * hop and could end up on a stale action (runner stuck in the jump/slide
   * pose while the world kept moving).
   */
  private refreshFinishedListener() {
    if (this.animationMixer && this.animationFinishedHandler) {
      this.animationMixer.removeEventListener('finished', this.animationFinishedHandler);
    }
    if (!this.animationMixer) return;
    this.animationFinishedHandler = () => {
      if (this.isGameOver || this.isPausedState()) return;
      const action = this.currentAnimation;
      if (action !== this.jumpingAnimation && action !== this.slidingAnimation) return;
      // Return to the run only once the pose that was playing has ended and
      // the matching movement (hop / slide) is actually over.
      if (action === this.jumpingAnimation && this.isJumping) return;
      if (action === this.slidingAnimation && this.isSliding) return;
      action.fadeOut(0.1);
      this.runningAnimation.reset();
      this.runningAnimation.setEffectiveWeight(1);
      this.runningAnimation.play();
      this.currentAnimation = this.runningAnimation;
    };
    this.animationMixer.addEventListener('finished', this.animationFinishedHandler);
  }

  private isPausedState() {
    return this.isGamePaused;
  }

  private createRandomObstacle() {
    let randomNum = Math.floor(Math.random() * this.obstacleArray.length);

    while (this.obstacleArray[randomNum] === this.currentObstacleOne
      || this.obstacleArray[randomNum] === this.currentObstacleTwo) {
      randomNum = Math.floor(Math.random() * this.obstacleArray.length);
    }
    return this.obstacleArray[randomNum];
  }

  private spawnObstacle() {
    if (!this.currentObstacleOne.visible) {
      this.currentObstacleOne.visible = true;
    }

    if (!this.currentObstacleTwo.visible) {
      this.currentObstacleTwo.visible = true;
      this.currentObstacleTwo.position.z = this.currentObstacleOne.position.z - 450;
    }

    this.currentObstacleOne.position.z += this.speed * this.delta;
    this.currentObstacleTwo.position.z += this.speed * this.delta;

    if (this.currentObstacleOne.position.z > -40) {
      this.currentObstacleOne.visible = false;
      this.currentObstacleOne.position.z = -1100;
      this.currentObstacleOne = this.createRandomObstacle();
    }

    if (this.currentObstacleTwo.position.z > -40) {
      this.currentObstacleTwo.visible = false;
      this.currentObstacleTwo.position.z = this.currentObstacleOne.position.z - 450;
      this.currentObstacleTwo = this.createRandomObstacle();
    }
  }

  private detectCollisionWithCoins() {
    for (let i = 0; i < this.activeCoinsGroup.children.length; i += 1) {
      this.coinBox.setFromObject(this.activeCoinsGroup.children[i]);
      if (this.playerBoxCollider.intersectsBox(this.coinBox)) {
        this.activeCoinsGroup.children[i].visible = false;
        this.activeCoinsGroup.children[i].position.z += 70;
        if (!this.isGamePaused && !this.isGameOver) {
          this.coins += 1;
        }
        (document.querySelector('.coins-count') as HTMLInputElement).innerHTML = `${this.coins}`;
        setTimeout(() => {
          this.activeCoinsGroup.children[i].position.z -= 70;
        }, 100);
      }
    }
  }

  private generateRandomCoins() {
    const randNum = Math.floor(Math.random() * this.coinsArray.length);
    this.activeCoinsGroup = this.coinsArray[randNum];
  }

  private spawnCoin() {
    if (!this.activeCoinsGroup.visible) {
      this.activeCoinsGroup.visible = true;
    }

    this.activeCoinsGroup.position.z += 0.8 * this.speed * this.delta;
    if (this.activeCoinsGroup.position.z > 50) {
      for (let i = 0; i < this.activeCoinsGroup.children.length; i += 1) {
        if (!this.activeCoinsGroup.children[i].visible) {
          this.activeCoinsGroup.children[i].visible = true;
        }
      }
      this.activeCoinsGroup.visible = false;
      this.activeCoinsGroup.position.z = -1200;
      this.generateRandomCoins();
    }
  }

  private pauseAndResumeGame() {
    if (!this.isGamePaused) {
      this.clock.stop();
      (document.getElementById('game-paused-modal') as HTMLInputElement).style.display = 'block';
      this.isGamePaused = true;
    } else {
      this.clock.start();
      (document.getElementById('game-paused-modal') as HTMLInputElement).style.display = 'none';
      this.isGamePaused = false;
    }
    this.saveCoins();
    this.saveHighScore();
  }

  private async saveHighScore() {
    const highScore = localStorage.getItem('high-score') || 0;
    if (Number(this.scores) > Number(highScore)) {
      localStorage.setItem('high-score', this.scores.toString());
      const token = localStorage.getItem('token');
      if (token) {
        try {
          (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'block';
          const response = await fetch('/.netlify/functions/save-highscore', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              authorization: token,
            },
            body: JSON.stringify({ scores: this.scores }),
          });
          (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'none';
          if (response.status === 401) {
            localStorage.removeItem('token');
          }
        } catch (error) {
          (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'none';
        }
      }
    }
  }

  private async saveCoins() {
    const prevTotalCoins = localStorage.getItem('total-coins') || 0;
    const totalCoins = Number(prevTotalCoins) + this.coins;
    localStorage.setItem('total-coins', totalCoins.toString());

    const token = localStorage.getItem('token');
    if (token) {
      (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'block';
      try {
        const response = await fetch('/.netlify/functions/save-coins', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            authorization: token,
          },
          body: JSON.stringify({ coins: totalCoins }),
        });
        (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'none';
        if (response.status === 401) {
          Toastify({
            text: 'Your session has expired. Please relogin',
            duration: 5000,
            close: true,
            gravity: 'bottom',
            position: 'center',
            stopOnFocus: true,
          }).showToast();
          localStorage.removeItem('token');
        }
      } catch (error) {
        (document.querySelector('.auto-save-loader') as HTMLInputElement).style.display = 'none';
      }
    }
  }

  /*
This implementation of handleTouch Method is based on Smmehrab answer on stackoverflow
Link: https://stackoverflow.com/a/62825217
  */

  private handleTouch = () => {
    const x = this.touchendX - this.touchstartX;
    const y = this.touchendY - this.touchstartY;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    // A sideways swipe has to beat the vertical one clearly, otherwise a mostly
    // vertical flick that drifts a little sideways was read as a lane change
    // and the jump/slide never happened.
    if (absX < SWIPE_MIN_DISTANCE && absY < SWIPE_MIN_DISTANCE) return;
    if (absX > absY * 1.25) {
      if (x < 0) {
        this.moveLeft();
      } else {
        this.moveRight();
      }
      return;
    }
    if (absY >= absX) {
      if (y < 0) {
        this.jump();
      } else {
        this.slide();
      }
    }
  };

  private createLeftJumpObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(0, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.spikeObject.clone();
    mesh3.scale.set(0.06, 0.06, 0.06);
    mesh3.position.set(-20, -31, 0);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -800);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createCenterJumpObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.spikeObject.clone();
    mesh3.scale.set(0.06, 0.06, 0.06);
    mesh3.position.set(0, -31, 0);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createRightJumpObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(0, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.spikeObject.clone();
    mesh3.scale.set(0.06, 0.06, 0.06);
    mesh3.position.set(20, -31, 0);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createRightCenterObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(0, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createLeftCenterObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(0, -25, 0);
    meshGroup.add(mesh2);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createLeftRightObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createCenterRightObstacle() {
    const meshGroup = new Group();
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.031, 0.031, 0.031);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createCenterSlideObstacle() {
    const meshGroup = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshPhongMaterial({ color: 'brown' });
    const plank = new Mesh(geometry, material);
    meshGroup.add(plank);
    plank.position.set(0, -20, 0);
    plank.scale.set(40, 0.5, 7);
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(20, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.boxObject.clone();
    mesh3.scale.set(4, 2, 2);
    mesh3.position.set(0, -19, 3);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createRightSlideObstacle() {
    const meshGroup = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshPhongMaterial({ color: 'brown' });
    const plank = new Mesh(geometry, material);
    meshGroup.add(plank);
    plank.position.set(20, -20, 0);
    plank.scale.set(40, 0.5, 7);
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(-20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(0, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.boxObject.clone();
    mesh3.scale.set(4, 2, 2);
    mesh3.position.set(20, -19, 3);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private createLeftSlideObstacle() {
    const meshGroup = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshPhongMaterial({ color: 'brown' });
    const plank = new Mesh(geometry, material);
    meshGroup.add(plank);
    plank.position.set(-20, -20, 0);
    plank.scale.set(40, 0.5, 7);
    const mesh = this.barrelObject.clone();
    mesh.scale.set(0.03, 0.03, 0.03);
    mesh.position.set(20, -25, 0);
    meshGroup.add(mesh);
    const mesh2 = this.barrelObject.clone();
    mesh2.scale.set(0.03, 0.03, 0.03);
    mesh2.position.set(0, -25, 0);
    meshGroup.add(mesh2);
    const mesh3 = this.boxObject.clone();
    mesh3.scale.set(4, 2, 2);
    mesh3.position.set(-20, -19, 3);
    meshGroup.add(mesh3);
    meshGroup.position.set(0, 0, -1200);
    this.add(meshGroup);
    meshGroup.visible = false;
    this.obstacleArray.push(meshGroup);
  }

  private generateLeftCenterRightCoins() {
    const coinsGroup = new Group();
    for (let i = 0; i < 5; i += 1) {
      const leftCoin = this.coinObject.clone();
      const centerCoin = this.coinObject.clone();
      const rightCoin = this.coinObject.clone();
      leftCoin.position.set(-18, -12, -i * 20);
      centerCoin.position.set(0, -12, -i * 20);
      rightCoin.position.set(18, -12, -i * 20);
      leftCoin.scale.set(0.035, 0.035, 0.035);
      centerCoin.scale.set(0.035, 0.035, 0.035);
      rightCoin.scale.set(0.035, 0.035, 0.035);
      coinsGroup.add(leftCoin, centerCoin, rightCoin);
    }
    coinsGroup.position.set(0, -20, -1200);
    this.add(coinsGroup);
    coinsGroup.visible = false;
    this.coinsArray.push(coinsGroup);
  }

  private generateLeftSideCoin() {
    const coinsGroup = new Group();
    for (let i = 0; i < 5; i += 1) {
      const leftCoin = this.coinObject.clone();
      leftCoin.position.set(-18, -12, -i * 20);
      leftCoin.scale.set(0.035, 0.035, 0.035);
      coinsGroup.add(leftCoin);
    }
    coinsGroup.position.set(0, -20, -1200);
    this.add(coinsGroup);
    coinsGroup.visible = false;
    this.coinsArray.push(coinsGroup);
  }

  private generateLeftandCenterCoins() {
    const coinsGroup = new Group();
    for (let i = 0; i < 5; i += 1) {
      const leftCoin = this.coinObject.clone();
      const centerCoin = this.coinObject.clone();
      leftCoin.position.set(-18, -12, -i * 20);
      centerCoin.position.set(0, -12, -i * 20);
      leftCoin.scale.set(0.035, 0.035, 0.035);
      centerCoin.scale.set(0.035, 0.035, 0.035);
      coinsGroup.add(leftCoin, centerCoin);
    }
    coinsGroup.position.set(0, -20, -1200);
    this.add(coinsGroup);
    coinsGroup.visible = false;
    this.coinsArray.push(coinsGroup);
  }

  private generateCenterRightCoins() {
    const coinsGroup = new Group();
    for (let i = 0; i < 5; i += 1) {
      const centerCoin = this.coinObject.clone();
      const rightCoin = this.coinObject.clone();
      centerCoin.position.set(0, -12, -i * 20);
      rightCoin.position.set(18, -12, -i * 20);
      coinsGroup.add(centerCoin, rightCoin);
      centerCoin.scale.set(0.035, 0.035, 0.035);
      rightCoin.scale.set(0.035, 0.035, 0.035);
    }
    coinsGroup.position.set(0, -20, -1200);
    this.add(coinsGroup);
    coinsGroup.visible = false;
    this.coinsArray.push(coinsGroup);
  }

  private generateRightCoins() {
    const coinsGroup = new Group();
    for (let i = 0; i < 5; i += 1) {
      const rightCoin = this.coinObject.clone();
      rightCoin.position.set(18, -12, -i * 20);
      coinsGroup.add(rightCoin);
      rightCoin.scale.set(0.035, 0.035, 0.035);
    }
    coinsGroup.position.set(0, -20, -1200);
    this.add(coinsGroup);
    coinsGroup.visible = false;
    this.coinsArray.push(coinsGroup);
  }
}
