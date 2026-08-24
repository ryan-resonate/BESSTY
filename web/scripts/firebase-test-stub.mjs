// Stands in for the Firebase SDK when bundling tests.
//
// The real SDK is a CommonJS bundle that requires node builtins at load time,
// so esbuild's ESM output dies on `Dynamic require of "process"` the moment any
// test transitively imports `lib/catalog`. That is most of the app — the
// curtailment model, the exporters, anything that resolves a catalog entry —
// and none of those tests want a real Firebase.
//
// Every export is a function that throws if CALLED. Importing is free, which is
// all a pure-logic test needs; a test that genuinely reaches the network gets a
// loud, named failure rather than a mystery.

function unavailable(name) {
  return () => {
    throw new Error(
      `Firebase (${name}) is stubbed in tests. A unit test should not reach the `
      + 'network — inject the data it needs instead.',
    );
  };
}

export const initializeApp = unavailable('initializeApp');
export const getApps = () => [];
export const getAuth = unavailable('getAuth');
export const getFirestore = unavailable('getFirestore');
export const getStorage = unavailable('getStorage');
export const getAnalytics = unavailable('getAnalytics');
export const isSupported = async () => false;

// Firestore surface used by `firestoreCatalog` / `firestoreProjects`. These are
// only ever reached through a subscription the tests never start.
export const collection = unavailable('collection');
export const doc = unavailable('doc');
export const getDoc = unavailable('getDoc');
export const getDocs = unavailable('getDocs');
export const setDoc = unavailable('setDoc');
export const addDoc = unavailable('addDoc');
export const updateDoc = unavailable('updateDoc');
export const deleteDoc = unavailable('deleteDoc');
export const onSnapshot = unavailable('onSnapshot');
export const query = unavailable('query');
export const where = unavailable('where');
export const orderBy = unavailable('orderBy');
export const limit = unavailable('limit');
export const writeBatch = unavailable('writeBatch');
export const serverTimestamp = unavailable('serverTimestamp');
export const Timestamp = { now: unavailable('Timestamp.now') };
export const arrayUnion = unavailable('arrayUnion');
export const arrayRemove = unavailable('arrayRemove');
export const deleteField = unavailable('deleteField');
export const runTransaction = unavailable('runTransaction');

// Auth surface.
export const onAuthStateChanged = unavailable('onAuthStateChanged');
export const signInWithEmailAndPassword = unavailable('signInWithEmailAndPassword');
export const createUserWithEmailAndPassword = unavailable('createUserWithEmailAndPassword');
export const signOut = unavailable('signOut');
export const sendPasswordResetEmail = unavailable('sendPasswordResetEmail');
export const updateProfile = unavailable('updateProfile');

// Storage surface.
export const ref = unavailable('ref');
export const uploadBytes = unavailable('uploadBytes');
export const uploadBytesResumable = unavailable('uploadBytesResumable');
export const getDownloadURL = unavailable('getDownloadURL');
export const deleteObject = unavailable('deleteObject');
