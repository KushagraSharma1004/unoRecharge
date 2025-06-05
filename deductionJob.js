// deductionJob.js
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  getDocs,
  writeBatch,
  serverTimestamp,
  doc
} = require('firebase/firestore');
require('dotenv').config(); // Load environment variables

// --- Firebase Initialization (repeated in separate files, but necessary for standalone execution) ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// --- Daily deduction logic ---
const performDeduction = async () => {
  try {
    console.log('Starting balance deduction process (CRON JOB)...', new Date().toISOString());
    const usersCol = collection(db, 'users');
    const usersSnapshot = await getDocs(usersCol);
    const deductionAmount = 12; // Hardcoded deduction amount

    if (usersSnapshot.empty) {
      console.log('No users found to process (CRON JOB).', new Date().toISOString());
      return;
    }

    const batch = writeBatch(db);
    let processedCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;

      if (currentBalance >= deductionAmount) {
        const newBalance = currentBalance - deductionAmount;
        batch.update(userDoc.ref, {
          balance: newBalance,
          lastDeduction: serverTimestamp()
        });

        const deductionsCol = collection(db, `users/${userDoc.id}/deductions`);
        const deductionRef = doc(deductionsCol);
        batch.set(deductionRef, {
          amount: deductionAmount,
          previousBalance: currentBalance,
          newBalance: newBalance,
          timestamp: serverTimestamp(),
          type: 'daily_charge'
        });
        processedCount++;
      }
    }

    if (processedCount > 0) {
      await batch.commit();
      console.log(`✅ Success (CRON JOB): Deducted ₹${deductionAmount} from ${processedCount} users.`, new Date().toISOString());
    } else {
      console.log('No users had sufficient balance for deduction or all balances were too low (CRON JOB).', new Date().toISOString());
    }
  } catch (error) {
    console.error('❌ Deduction failed (CRON JOB):', error, new Date().toISOString());
  } finally {
    // IMPORTANT: Exit the process cleanly for Render's cron job.
    // Without this, the job might hang or timeout.
    console.log('Deduction job finished. Exiting.');
    process.exit(0);
  }
};

// Execute the deduction function when this script is run
performDeduction();