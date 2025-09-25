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
      case "getCustomerByPhone": // <-- ADD THIS NEW CASE
      return await handleGetCustomerByPhone(req, res);

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

// Replace your old handleFindAvailableSlots function with this one

async function handleFindAvailableSlots(req, res) {
  console.log("--- Starting findAvailableSlots ---");

  // Log the exact inputs received from the agent
  const { region, skill, appliance, preferred_day } = req.body;
  console.log("Inputs Received:", { region, skill, appliance, preferred_day });

  // 1. Get the target date and day of the week
  const { dateString, dayOfWeek } = getDateInfo(preferred_day);
  console.log("Calculated Date Info:", { dateString, dayOfWeek });

  // 2. Get qualified technician IDs from indexes
  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  const applianceTechsSnap = await db.ref(`/techniciansByAppliance/${appliance}`).once("value");

  if (!skilledTechsSnap.exists() || !applianceTechsSnap.exists()) {
    console.log("Result: No technicians found for this skill or appliance in the indexes.");
    return res.status(200).send({ slots: [] });
  }

  const skilledTechs = Object.keys(skilledTechsSnap.val());
  const applianceTechs = Object.keys(applianceTechsSnap.val());
  const potentialTechIds = skilledTechs.filter(id => applianceTechs.includes(id));
  console.log("Potential Tech IDs after index lookup:", potentialTechIds);

  if (potentialTechIds.length === 0) {
    console.log("Result: No technicians matched both skill and appliance.");
    return res.status(200).send({ slots: [] });
  }
  
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  // 4. Loop through potential technicians to calculate slots
  for (const techId of potentialTechIds) {
    console.log(`\n--- Checking Technician: ${techId} ---`);
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();

    // 5. Final filtering by region and working hours
    if (technician && technician.TechRegion === region) {
      console.log(`Region Match: SUCCESS (${technician.TechRegion} === ${region})`);
      const workingHours = technician.working_hours[dayOfWeek];
      
      if (workingHours && workingHours !== "none") {
        console.log(`Schedule Match: SUCCESS (Works on ${dayOfWeek} from ${workingHours})`);
        const bookedSlots = todaysAppointments[techId] || [];
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        console.log(`Calculated Free Slots for ${techId}:`, freeSlots);
        allAvailableSlots.push(...freeSlots);
      } else {
        console.log(`Schedule Match: FAILED (Technician does not work on ${dayOfWeek})`);
      }
    } else {
      console.log(`Region Match: FAILED (Technician region is '${technician.TechRegion}', but request is for '${region}')`);
    }
  }

  // 7. Return a clean, sorted, unique list of slots
  const uniqueSlots = [...new Set(allAvailableSlots)].sort();
  console.log("Final unique slots to be returned:", uniqueSlots);
  console.log("--- Function Finished ---");
  return res.status(200).send({ slots: uniqueSlots.slice(0, 4) });
}

async function handleGetCustomerByPhone(req, res) {
  const phone = req.body.phone;

  if (!phone || phone.length !== 10) {
    return res.status(400).send({ error: "A valid 10-digit phone number is required." });
  }

  // Construct the direct path to the customer data
  const customerRef = db.ref(`/customers/${phone}`);
  const snapshot = await customerRef.once("value");

  if (snapshot.exists()) {
    // Customer found, return their details
    return res.status(200).send({ customer: snapshot.val() });
  } else {
    // No customer found for this number
    return res.status(200).send({ customer: null });
  }
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