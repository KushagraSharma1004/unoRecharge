// import { initializeApp } from 'firebase/app';
// import { getFirestore, collection, getDocs, writeBatch, serverTimestamp } from 'firebase/firestore';
// import cron from 'node-cron';

// // Initialize Firebase
// const firebaseConfig = {
//   apiKey: process.env.FIREBASE_API_KEY,
//   authDomain: process.env.FIREBASE_AUTH_DOMAIN,
//   projectId: process.env.FIREBASE_PROJECT_ID,
//   storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
//   messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
//   appId: process.env.FIREBASE_APP_ID
// };

// const app = initializeApp(firebaseConfig);
// const db = getFirestore(app);

// const performDailyDeduction = async () => {
//   try {
//     console.log('Starting daily balance deduction process...', new Date().toISOString());
    
//     const vendorsCol = collection(db, 'users');
//     const vendorsSnapshot = await getDocs(vendorsCol);
//     const deductionAmount = 4;
    
//     const batch = writeBatch(db);
//     let processedCount = 0;

//     vendorsSnapshot.forEach((doc) => {
//       const vendorData = doc.data();
//       const currentBalance = vendorData.balance || 0;
      
//       if (currentBalance >= deductionAmount) {
//         const newBalance = currentBalance - deductionAmount;
//         batch.update(doc.ref, {
//           balance: newBalance,
//           lastDeduction: serverTimestamp()
//         });
//         processedCount++;
        
//         const deductionsCol = collection(db, `users/${doc.id}/deductions`);
//         const deductionRef = doc(deductionsCol);
//         batch.set(deductionRef, {
//           amount: deductionAmount,
//           previousBalance: currentBalance,
//           newBalance: newBalance,
//           timestamp: serverTimestamp(),
//           type: 'daily_charge'
//         });
//       }
//     });

//     await batch.commit();
//     console.log(`Completed: Deducted ₹4 from ${processedCount} vendors`, new Date().toISOString());
    
//   } catch (error) {
//     console.error('Deduction failed:', error, new Date().toISOString());
//   }
// };

// // Schedule to run every day at 12:00 AM
// cron.schedule('0 0 * * *', performDailyDeduction, {
//   scheduled: true,
//   timezone: "Asia/Kolkata"
// });

// console.log('Daily deduction scheduler started...');

// // For manual testing
// export const manualTrigger = () => {
//   console.log('Manually triggering deduction...');
//   performDailyDeduction();
// };
