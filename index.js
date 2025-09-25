const express = require('express');
const admin = require('firebase-admin');

// --- INITIALIZATION ---
// Get your service account credentials from Render's environment variables
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

// Initialize Firebase Admin with credentials AND the database URL
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://serveeasy-8565e-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const app = express();
app.use(express.json()); // Middleware to parse JSON bodies


// --- MAIN HANDLER / ROUTER ---
// This is the single endpoint that your Inya AI agent will call
app.post('/api/handler', async (req, res) => {
  const task = req.body.task;
  
  try {
    switch (task) {
      case "getRegionByKey":
        return await handleGetRegionByKey(req, res);
      
      case "findAvailableSlots":
        return await handleFindAvailableSlots(req, res);

      // Add a placeholder for when you're ready to save a confirmed appointment
      case "confirmBooking":
        const { dateString, slot, techId, customerInfo } = req.body;
        // Your logic to write to the `/appointments/{dateString}/{techId}` path would go here
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


// --- TASK LOGIC ---

async function handleGetRegionByKey(req, res) {
  const pincode = req.body.pincode;
  if (!pincode || pincode.length !== 6) {
    return res.status(400).send({ error: "A valid 6-digit pincode is required." });
  }
  const prefix = pincode.substring(0, 3);
  const regionRef = db.ref(`/regions/${prefix}`);
  const snapshot = await regionRef.once("value");
  const regionName = snapshot.val();

  return res.status(200).send({ region: regionName || null });
}

async function handleFindAvailableSlots(req, res) {
  const { region, skill, appliance, preferred_day } = req.body;
  
  const { dateString, dayOfWeek } = getDateInfo(preferred_day);

  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  const applianceTechsSnap = await db.ref(`/techniciansByAppliance/${appliance}`).once("value");

  if (!skilledTechsSnap.exists() || !applianceTechsSnap.exists()) {
      return res.status(200).send({ slots: [] });
  }

  const skilledTechs = Object.keys(skilledTechsSnap.val());
  const applianceTechs = Object.keys(applianceTechsSnap.val());
  const potentialTechIds = skilledTechs.filter(id => applianceTechs.includes(id));
  
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  for (const techId of potentialTechIds) {
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();

    if (technician && technician.TechRegion === region) {
      const workingHours = technician.working_hours[dayOfWeek];
      if (workingHours && workingHours !== "none") {
        const bookedSlots = todaysAppointments[techId] || [];
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        allAvailableSlots.push(...freeSlots);
      }
    }
  }

  const uniqueSlots = [...new Set(allAvailableSlots)].sort();
  return res.status(200).send({ slots: uniqueSlots.slice(0, 4) });
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
    const now = new Date();
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    
    if (preferredDay && preferredDay.toLowerCase() === 'tomorrow') {
        now.setDate(now.getDate() + 1);
    }
    
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    
    return {
        dateString: `${year}-${month}-${day}`,
        dayOfWeek: dayNames[now.getDay()]
    };
}


// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});