const express = require('express');
const admin = require('firebase-admin');

// --- INITIALIZATION ---
// This code expects your Firebase service account key to be in an environment variable
// named FIREBASE_SERVICE_ACCOUNT_JSON on your Render dashboard.
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://serveeasy-8565e-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
} catch (error) {
  console.error("Firebase initialization failed:", error);
}


const db = admin.database();
const app = express();
app.use(express.json());


// --- MAIN HANDLER / ROUTER ---
// This is the single endpoint that your Inya AI agent will call
app.post('/api/handler', async (req, res) => {
  const task = req.body.task;
  
  try {
    switch (task) {
      case "getCustomerByPhone":
        return await handleGetCustomerByPhone(req, res);

      case "getRegionByKey":
        return await handleGetRegionByKey(req, res);
      
      case "findAvailableSlots":
        return await handleFindAvailableSlots(req, res);

      case "confirmBooking":
        const { dateString, slot, techId, customerInfo } = req.body;
        // Logic to write to the `/appointments/{dateString}/{techId}` path would go here
        const ticketId = `TICKET-${Date.now()}`;
        return res.status(200).send({ status: "confirmed", ticketId: ticketId });

      default:
        return res.status(400).send({ error: "Invalid task specified" });
    }
  } catch (error) {
    console.error(`Error processing task "${task}":`, error);
    return res.status(500).send({ error: "An internal server error occurred." });
  }
});


// --- TASK LOGIC FUNCTIONS ---

async function handleGetCustomerByPhone(req, res) {
  const phone = req.body.phone;
  console.log(`--- Starting getCustomerByPhone for: ${phone} ---`);
  if (!phone || phone.length !== 10) {
    return res.status(400).send({ error: "A valid 10-digit phone number is required." });
  }
  const customerRef = db.ref(`/customers/${phone}`);
  const snapshot = await customerRef.once("value");
  if (snapshot.exists()) {
    console.log(`Customer found for ${phone}.`);
    return res.status(200).send({ customer: snapshot.val() });
  } else {
    console.log(`No customer found for ${phone}.`);
    return res.status(200).send({ customer: null });
  }
}

async function handleGetRegionByKey(req, res) {
  const pincode = req.body.pincode;
  console.log(`--- Starting getRegionByKey for: ${pincode} ---`);
  if (!pincode || pincode.length !== 6) {
    return res.status(400).send({ error: "A valid 6-digit pincode is required." });
  }
  const prefix = pincode.substring(0, 3);
  const regionRef = db.ref(`/regionCache/${prefix}`);
  const snapshot = await regionRef.once("value");
  const regionName = snapshot.val();
  console.log(`Found region '${regionName}' for prefix '${prefix}'.`);
  return res.status(200).send({ region: regionName || null });
}


async function handleFindAvailableSlots(req, res) {
  console.log("--- Starting findAvailableSlots ---");
  const { region, skill, appliance, preferred_day } = req.body;

  const { dateString, dayOfWeek } = getDateInfo(preferred_day);

  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  if (!skilledTechsSnap.exists()) {
    return res.status(200).send({ slots: [] });
  }
  const potentialTechIds = Object.keys(skilledTechsSnap.val());
  
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  for (const techId of potentialTechIds) {
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();
    if (!technician) continue;

    const regionMatch = technician.TechRegion === region;
    const applianceMatch = Array.isArray(technician.appliances_supported) && technician.appliances_supported.includes(appliance);

    if (regionMatch && applianceMatch) {
      const workingHours = technician.working_hours[dayOfWeek];
      if (workingHours && workingHours !== "none") {
        const bookedSlots = todaysAppointments[techId] || [];
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        
        // --- THIS IS THE KEY CHANGE ---
        // Instead of just adding strings, create rich objects
        for (const slotTime of freeSlots) {
            allAvailableSlots.push({
                time: slotTime,
                techId: techId, // Use the ID from the loop
                techName: technician.TechName
            });
        }
        // --- END OF CHANGE ---
      }
    }
  }

  // Sort slots by time
  allAvailableSlots.sort((a, b) => a.time.localeCompare(b.time));
  
  return res.status(200).send({ slots: allAvailableSlots.slice(0, 4) });
}


// --- HELPER FUNCTIONS ---

function calculateFreeSlots(workingHours, bookedSlots) {
  const [workStart, workEnd] = workingHours.split('-').map(timeToMinutes);
  const serviceDuration = 120; // 2 hours
  let availableSlots = [];
  let currentTime = workStart;
  bookedSlots.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  for (const booked of bookedSlots) {
    const bookedStart = timeToMinutes(booked.start);
    const bookedEnd = timeToMinutes(booked.end);
    while (currentTime + serviceDuration <= bookedStart) {
      availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
      currentTime += serviceDuration;
    }
    currentTime = Math.max(currentTime, bookedEnd);
  }
  while (currentTime + serviceDuration <= workEnd) {
    availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
    currentTime += serviceDuration;
  }
  return availableSlots;
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function getDateInfo(preferredDay) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    let targetDate = new Date();
    
    if (preferredDay && preferredDay.toLowerCase() === 'tomorrow') {
        targetDate.setDate(targetDate.getDate() + 1);
    }
    // You can add more logic here for specific days like "saturday", etc.
    
    const year = targetDate.getFullYear();
    const month = (targetDate.getMonth() + 1).toString().padStart(2, '0');
    const day = targetDate.getDate().toString().padStart(2, '0');
    
    return {
        dateString: `${year}-${month}-${day}`,
        dayOfWeek: dayNames[targetDate.getDay()]
    };
}


// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});