// Test-only: firebase-functions' emulator debug switch, so the CORS test can
// send a signed-in request with an unsigned ID token. Must load before
// firebase-functions (it reads these at module load). Never set in deployed
// functions — there every ID token is verified.
process.env.FIREBASE_DEBUG_MODE = 'true';
process.env.FIREBASE_DEBUG_FEATURES = JSON.stringify({ skipTokenVerification: true });
