// face-verify.js -- WebRTC selfie capture for facial biometric verification.
//
// Flow: enable camera -> capture burst (1 selfie + 6 liveness frames over ~1.2s)
//       -> create a server challenge -> POST { action: 'verify_face' } to the
//          verify-identity Edge Function.
//
// The server owns the decision. Nothing here can mark an account verified: this
// file only sends frames, and the function only accepts one selfie per
// challenge, for the signed-in user (see verify-identity/index.ts).
//
// Exposes window.OddZoneFaceVerify = { mount(host) } so the card can also be
// dropped into an existing modal instead of using face-verify.html.

(() => {
    'use strict';

    const FUNCTION_NAME = 'verify-identity';
    const LIVENESS_FRAME_COUNT = 6;
    const CAPTURE_INTERVAL_MS = 200;
    const COUNTDOWN_STEPS = ['3', '2', '1'];
    const COUNTDOWN_STEP_MS = 550;
    const FRAME_MAX_EDGE = 720;
    const LIVENESS_MAX_EDGE = 480;
    const JPEG_QUALITY = 0.86;

    /* ── Small helpers ─────────────────────────────────────────────────── */

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const waitForVideo = (video, timeoutMs = 8000) => new Promise((resolve, reject) => {
        if (video.readyState >= 2 && video.videoWidth) return resolve();
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('The camera started but produced no picture. Try another browser or device.'));
        }, timeoutMs);
        const check = () => {
            if (video.readyState >= 2 && video.videoWidth) {
                cleanup();
                resolve();
            }
        };
        const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener('loadeddata', check);
            video.removeEventListener('playing', check);
        };
        video.addEventListener('loadeddata', check);
        video.addEventListener('playing', check);
    });

    /**
     * Environment diagnostics are the most common cause of a black camera. They
     * are reported as plain text (never thrown), so the page can tell a user
     * what to change instead of showing "camera unavailable".
     */
    function cameraSupportError() {
        if (!window.isSecureContext) {
            return 'Camera access needs HTTPS. Open OddZone over https:// or on localhost.';
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            return 'This browser does not expose a camera API. Update your browser and try again.';
        }
        return null;
    }

    function isEmbeddedViewer() {
        try {
            return window.self !== window.top;
        } catch {
            return true;
        }
    }

    /** Draw the visible centre square of the video to a canvas and export JPEG. */
    function grabFrame(video, maxEdge) {
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        if (!sourceWidth || !sourceHeight) throw new Error('Camera frame is not ready yet.');

        const side = Math.min(sourceWidth, sourceHeight);
        const scale = Math.min(1, maxEdge / side);
        const outputSide = Math.round(side * scale);
        const canvas = document.createElement('canvas');
        canvas.width = outputSide;
        canvas.height = outputSide;
        const context = canvas.getContext('2d');
        // Face circles are centred; crop to the centre square rather than
        // squashing a 16:9 sensor into a portrait frame.
        context.drawImage(
            video,
            (sourceWidth - side) / 2,
            (sourceHeight - side) / 2,
            side,
            side,
            0,
            0,
            outputSide,
            outputSide,
        );
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    }

    /** Bytes in the base64 part -- checked again server-side after decoding. */
    const approximateBytes = (dataUrl) => {
        const comma = dataUrl.indexOf(',');
        return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
    };

    /* ── Camera ────────────────────────────────────────────────────────── */

    function createCamera() {
        let stream = null;

        return {
            async start() {
                const supportError = cameraSupportError();
                if (supportError) throw new Error(supportError);
                if (stream) return stream;

                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: 'user',
                        width: { ideal: 1280 },
                        height: { ideal: 1280 },
                        // No mirroring at the source: the same frames are what the
                        // provider receives, so the preview must not disagree.
                        // (The CSS mirror is presentation only.)
                    },
                });
                return stream;
            },
            stop() {
                if (!stream) return;
                for (const track of stream.getTracks()) track.stop();
                stream = null;
            },
            get active() {
                return Boolean(stream);
            },
        };
    }

    /* ── Component ─────────────────────────────────────────────────────── */

    function createFaceVerifier(root) {
        const $ = (selector) => root.querySelector(selector);

        const elements = {
            idType: $('#fv-id-type'),
            idNumber: $('#fv-id-number'),
            consent: $('#fv-consent'),
            stage: $('#fv-stage'),
            video: $('#webcam'),
            startButton: $('#fv-start-camera'),
            ring: $('#fv-ring'),
            countdown: $('#fv-countdown'),
            hint: $('#fv-hint'),
            captureButton: $('#fv-capture'),
            captureLabel: $('#fv-capture-label'),
            progress: $('#fv-progress-bar'),
            status: $('#fv-status'),
            statusText: $('#fv-status-text'),
        };

        const camera = createCamera();
        let busy = false;
        let disposed = false;
        // True once startCamera() has wired a live feed to the <video>. Kept
        // separate from camera.active so a QA harness can drive the
        // capture -> challenge -> verify path without a camera device.
        let ready = false;

        function setStatus(message, tone = 'info') {
            if (elements.status) elements.status.dataset.tone = tone;
            if (elements.statusText) elements.statusText.textContent = message;
        }

        /** Advances a determinate bar for the stages the client can time. */
        function setProgress(percent) {
            if (elements.progress) elements.progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }

        function setBusy(nextBusy, label) {
            busy = nextBusy;
            if (elements.captureButton) elements.captureButton.disabled = nextBusy || !ready;
            if (label && elements.captureLabel) elements.captureLabel.textContent = label;
            if (elements.idType) elements.idType.disabled = nextBusy;
            if (elements.idNumber) elements.idNumber.disabled = nextBusy;
            if (elements.consent) elements.consent.disabled = nextBusy;
            if (elements.ring) elements.ring.classList.toggle('is-scanning', nextBusy);
        }

        function showCountdown(value) {
            if (!elements.countdown) return;
            elements.countdown.textContent = value;
            elements.countdown.classList.add('is-visible');
        }

        function hideCountdown() {
            if (!elements.countdown) return;
            elements.countdown.classList.remove('is-visible');
        }

        async function startCamera() {
            if (busy || camera.active) return;
            const supportError = cameraSupportError();
            if (supportError) {
                setStatus(supportError, 'error');
                return;
            }

            const permission = navigator.permissions && typeof navigator.permissions.query === 'function'
                ? await navigator.permissions.query({ name: 'camera' }).catch(() => null)
                : null;
            if (permission && permission.state === 'denied') {
                setStatus(
                    'Camera access is blocked for this site. Open the site settings (the lock icon in the address bar), allow the camera, then reload.',
                    'error',
                );
                return;
            }
            setStatus(
                isEmbeddedViewer()
                    ? 'Requesting camera access. If no prompt appears, this preview frame may be blocking it: open face-verify.html directly.'
                    : 'Requesting camera access…',
                'busy',
            );
            try {
                const stream = await camera.start();
                if (disposed) {
                    camera.stop();
                    return;
                }
                elements.video.srcObject = stream;
                await elements.video.play().catch(() => undefined);
                await waitForVideo(elements.video);
                elements.video.classList.add('is-live');
                elements.stage.classList.add('is-live');
                ready = true;
                if (elements.captureButton) elements.captureButton.disabled = false;
                await updateReadiness();
            } catch (error) {
                camera.stop();
                elements.video.classList.remove('is-live');
                elements.stage.classList.remove('is-live');
                setStatus(cameraErrorMessage(error), 'error');
            }
        }

        function cameraErrorMessage(error) {
            switch (error && error.name) {
                case 'NotAllowedError':
                case 'SecurityError':
                    return 'Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.';
                case 'NotFoundError':
                case 'OverconstrainedError':
                    return 'No camera was found on this device. Verification needs a phone or laptop with a working front camera.';
                case 'NotReadableError':
                    return 'The camera is already in use by another app. Close it (video calls, other tabs) and try again.';
                default:
                    return (error && error.message) || 'The camera could not be started. Please try again.';
            }
        }

        function idIsValid() {
            const value = (elements.idNumber && elements.idNumber.value || '').replace(/\D/g, '');
            return /^\d{11}$/.test(value);
        }

        async function updateReadiness() {
            if (busy) return;
            if (!ready) {
                setStatus('Enter your ID number, tick consent, then enable the camera.');
                return;
            }
            if (!idIsValid()) {
                setStatus(`Enter the 11-digit ${(elements.idType && elements.idType.value || 'nin').toUpperCase()} to continue.`);
                return;
            }
            if (!elements.consent.checked) {
                setStatus('Tick the consent box so we can send your capture for verification.');
                return;
            }
            setStatus('Camera ready. Centre your face in the circle, then capture.');
        }

        /** Captures the selfie plus a short liveness burst. */
        async function captureBurst() {
            const selfie = grabFrame(elements.video, FRAME_MAX_EDGE);
            const liveness = [];
            for (let index = 0; index < LIVENESS_FRAME_COUNT; index += 1) {
                liveness.push(grabFrame(elements.video, LIVENESS_MAX_EDGE));
                if (index < LIVENESS_FRAME_COUNT - 1) await sleep(CAPTURE_INTERVAL_MS);
            }
            return { selfie, liveness };
        }

        async function resolveClient() {
            if (typeof window.getSupabaseAuthClient === 'function') {
                return window.getSupabaseAuthClient();
            }
            if (window.supabaseClientInstance) return window.supabaseClientInstance;
            const config = window.ODDZONE_CONFIG?.supabase || window.ODDZONE_SUPABASE_CONFIG || {
                url: 'https://csrfrzzpduhhzldirdfi.supabase.co',
                anonKey: 'sb_publishable_y_aWz0kwtbJYAcWfVNqGCg_CH4L3MHj',
            };
            if (window.supabase && typeof window.supabase.createClient === 'function') {
                window.supabaseClientInstance = window.supabase.createClient(config.url, config.anonKey, {
                    auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true },
                });
                return window.supabaseClientInstance;
            }
            return null;
        }

        async function invoke(client, body) {
            const { data, error } = await client.functions.invoke(FUNCTION_NAME, { body });
            if (error) {
                // supabase-js hides non-2xx bodies behind FunctionsHttpError, so
                // read the JSON body from the response to get our `reason`.
                let detail = null;
                try {
                    const response = error.context;
                    if (response && typeof response.clone === 'function') {
                        detail = await response.clone().json();
                    }
                } catch {
                    // Non-JSON error body (proxy/gateway) -- keep the generic message.
                }
                if (detail) return detail;
                const failureError = new Error(error.message || 'The verification service is unavailable.');
                failureError.reason = 'service_unavailable';
                throw failureError;
            }
            return data || {};
        }

        async function verify() {
            if (busy) return;

            const idNumber = (elements.idNumber.value || '').replace(/\D/g, '');
            const idType = elements.idType.value === 'bvn' ? 'bvn' : 'nin';
            if (!/^\d{11}$/.test(idNumber)) {
                setStatus(`Enter the 11-digit ${idType.toUpperCase()} printed on your record.`, 'error');
                elements.idNumber.focus();
                return;
            }
            if (!elements.consent.checked) {
                setStatus('Tick the consent box before capturing your face.', 'error');
                elements.consent.focus();
                return;
            }
            if (!ready) {
                await startCamera();
                // startCamera() reports the camera problem; retrying it here
                // instead would hide a bad ID or a missing consent behind it.
                if (!ready) return;
            }

            setBusy(true, 'Verifying identity…');
            setProgress(8);
            try {
                const client = await resolveClient();
                if (!client) {
                    throw Object.assign(new Error('Identity verification is unavailable. Check your connection.'), {
                        reason: 'service_unavailable',
                    });
                }
                const { data: sessionData, error: sessionError } = await client.auth.getSession();
                if (sessionError || !sessionData?.session) {
                    throw Object.assign(new Error('Please sign in to OddZone before verifying your identity.'), {
                        reason: 'unauthorized',
                    });
                }

                // 1. Hold still while the countdown runs -- gives the user a
                //    moment to settle and makes the burst frames less blurred.
                for (const step of COUNTDOWN_STEPS) {
                    showCountdown(step);
                    await sleep(COUNTDOWN_STEP_MS);
                }
                hideCountdown();
                if (elements.ring) elements.ring.classList.add('is-scanning');
                setProgress(18);

                // 2. Capture while the challenge is minted server-side.
                setStatus('Capturing your selfie and liveness check…', 'busy');
                setProgress(30);
                const challengePromise = invoke(client, {
                    action: 'create_face_challenge',
                    id_document_type: idType,
                });
                const { selfie, liveness } = await captureBurst();
                setProgress(45);
                if (approximateBytes(selfie) > 3 * 1024 * 1024) {
                    throw Object.assign(new Error('The camera image was too large. Move closer and try again.'), {
                        reason: 'invalid_selfie',
                    });
                }

                const challenge = await challengePromise;
                if (!challenge || challenge.success !== true || !challenge.challenge_id) {
                    throw Object.assign(
                        new Error(challenge?.message || challenge?.error || 'Could not start verification. Please retry.'),
                        { reason: challenge?.reason || 'missing_challenge' },
                    );
                }

                // 3. One shot per challenge. The server decides; nothing below
                //    can mark the account verified on its own.
                setStatus('Matching your selfie against the photo on file…', 'busy');
                setProgress(62);
                const result = await invoke(client, {
                    action: 'verify_face',
                    challenge_id: challenge.challenge_id,
                    nin_or_bvn: idNumber,
                    selfie_base64: selfie,
                    liveness_frames_base64: liveness,
                    consent_granted: true,
                });

                setProgress(100);
                if (result && result.success === true) {
                    const confidence = Number(result.confidence);
                    const scoreText = result.confidence_reported === false || !Number.isFinite(confidence)
                        ? 'Liveness and the government photo match were confirmed.'
                        : `Face match confidence: ${confidence}%.`;
                    const withdrawalText = result.withdrawal_eligible
                        ? 'Your verified legal name is ready for withdrawals.'
                        : 'Complete Smile ID verification in your profile to confirm your legal name before withdrawing.';
                    setStatus(`Identity verified. ${scoreText} ${withdrawalText}`, 'success');
                    setBusy(false, 'Verified');
                    if (elements.captureButton) elements.captureButton.disabled = true;
                    elements.idNumber.disabled = true;
                    elements.idType.disabled = true;
                    elements.consent.disabled = true;
                    camera.stop();
                    elements.video.classList.remove('is-live');
                    elements.stage.classList.remove('is-live');
                    window.dispatchEvent(new CustomEvent('oddzone:identity-verified', {
                        detail: { confidence, confidence_reported: result.confidence_reported !== false },
                    }));
                    return;
                }

                setProgress(0);
                const reason = result?.reason || 'verification_failed';
                if (reason === 'challenge_expired' || reason === 'challenge_consumed' || reason === 'missing_challenge') {
                    setStatus(`${result?.message || 'That capture expired.'} Capture again to retry.`, 'error');
                    setBusy(false, 'Capture & Verify Identity');
                    return;
                }
                if (reason === 'manual_review') {
                    setStatus(
                        'Your capture needs a manual review. Please contact support -- you can retry later.',
                        'pending',
                    );
                    setBusy(false, 'Capture & Verify Identity');
                    return;
                }
                if (reason === 'rate_limited') {
                    setStatus('Too many attempts. Wait a few minutes before trying again.', 'error');
                    setBusy(false, 'Capture & Verify Identity');
                    return;
                }
                setStatus(
                    result?.message
                        || (reason === 'face_verification_failed'
                            ? 'The selfie did not match the photo on file. Check the lighting and remove glasses or a hat, then retry.'
                            : 'Identity could not be verified. Check your details and try again.'),
                    'error',
                );
                setBusy(false, 'Retry Capture & Verify');
            } catch (error) {
                console.error('[OddZone] Face verification failed:', error);
                setProgress(0);
                hideCountdown();
                const message = error && error.reason === 'unauthorized'
                    ? error.message
                    : (error && error.message) || 'Verification failed. Please retry.';
                const tone = error && error.reason === 'manual_review' ? 'pending' : 'error';
                setStatus(message, tone);
                setBusy(false, 'Retry Capture & Verify');
            }
        }

        function wire() {
            elements.startButton?.addEventListener('click', startCamera);
            elements.captureButton?.addEventListener('click', verify);
            elements.idNumber?.addEventListener('input', () => {
                const digits = elements.idNumber.value.replace(/\D/g, '').slice(0, 11);
                if (digits !== elements.idNumber.value) elements.idNumber.value = digits;
                void updateReadiness();
            });
            elements.idType?.addEventListener('change', () => void updateReadiness());
            elements.consent?.addEventListener('change', () => void updateReadiness());

            // The policy lives in index.html's settings modal. When embedded, the
            // link would otherwise load the whole app inside the card's frame.
            root.querySelector('#fv-policy-link')?.addEventListener('click', (event) => {
                if (!isEmbeddedViewer()) return; // top-level: index.html#privacy handles it
                event.preventDefault();
                try {
                    window.top.location.hash = 'privacy';
                    if (typeof window.top.openPrivacyModal === 'function') window.top.openPrivacyModal();
                } catch {
                    window.open('index.html#privacy', '_blank', 'noopener');
                }
            });

            // Hard-stop the light: stopping tracks is the only reliable way.
            window.addEventListener('pagehide', () => camera.stop());
            // Mobile browsers suspend the feed when the tab is backgrounded; turn
            // the light off rather than leaving a frozen (or black) preview.
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) camera.stop();
            });
        }

        function destroy() {
            disposed = true;
            ready = false;
            camera.stop();
            elements.stage?.classList.remove('is-live');
            if (elements.video) {
                elements.video.pause();
                elements.video.srcObject = null;
            }
        }

        wire();

        return {
            destroy,
            verify,
            startCamera,
            // Lets a headless QA harness mark the feed ready after faking the
            // <video> dimensions; has no effect on real camera state.
            __setReadyForTests(value = true) {
                ready = Boolean(value);
                if (elements.captureButton) elements.captureButton.disabled = !ready;
            },
            get isBusy() {
                return busy;
            },
        };
    }

    /* ── Public API ────────────────────────────────────────────────────── */

    let instance = null;

    function mount(host) {
        const target = typeof host === 'string' ? document.querySelector(host) : host;
        if (!target) throw new Error('OddZoneFaceVerify.mount: host element not found.');
        if (instance) instance.destroy();
        if (!target.querySelector('#webcam')) {
            throw new Error('OddZoneFaceVerify.mount: the host must contain the face-verify markup. Copy the <main> from face-verify.html.');
        }
        instance = createFaceVerifier(target);
        return instance;
    }

    window.OddZoneFaceVerify = {
        mount,
        version: '1.0.0',
        // Populated if the page failed to start; inspect it in the console.
        lastError: null,
    };

    // Auto-mount on the standalone page.
    const autoRoot = document.getElementById('oddzone-face-verify');
    const start = () => {
        try {
            instance = createFaceVerifier(autoRoot);
        } catch (error) {
            // A throw here would otherwise end this script before anything is
            // reachable from the console.
            console.error('[OddZone] Could not start face verification:', error);
            window.OddZoneFaceVerify.lastError = String(error && error.message || error);
        }
    };

    if (autoRoot) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }
})();
