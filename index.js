const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK
admin.initializeApp();
const db = admin.database();

/**
 * Main Cloud Function to handle all requests from the Inya AI agent.
 * It acts as a router based on the 'task' field in the request body.
 */
exports.serviceAgentHandler = functions.https.onRequest(async (req, res) => {
  // Use POST method for all requests
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const task = req.body.task;

  try {
    switch (task) {
      case "getRegionByKey":
        return await handleGetRegionByKey(req, res);
      
      case "findAvailableSlots":
        return await handleFindAvailableSlots(req, res);
      
      case "confirmBooking":
        // Placeholder for when you're ready to save a confirmed appointment
        return await handleConfirmBooking(req, res);

      default:
        return res.status(400).send({ error: "Invalid task specified" });
    }
  } catch (error) {
    console.error("Error in serviceAgentHandler:", error);
    return res.status(500).send({ error: "An internal error occurred." });
  }
});


// --- Task Handlers ---

/**
 * Fetches a region name from the regionCache using a pincode prefix.
 */
async function handleGetRegionByKey(req, res) {
  const pincode = req.body.pincode;
  if (!pincode || pincode.length !== 6) {
    return res.status(400).send({ error: "A valid 6-digit pincode is required." });
  }
  const prefix = pincode.substring(0, 3);
  const regionRef = db.ref(`/regionCache/${prefix}`);
  const snapshot = await regionRef.once("value");
  const regionName = snapshot.val();

  if (regionName) {
    return res.status(200).send({ region: regionName });
  } else {
    return res.status(200).send({ region: null }); // Use 200 so the agent can handle "not supported"
  }
}

/**
 * The main scheduling logic to find available slots for qualified technicians.
 */
async function handleFindAvailableSlots(req, res) {
  const { region, skill, appliance, preferred_day } = req.body;
  
  // 1. Get the target date and day of the week (e.g., "2025-09-26" and "friday")
  const { dateString, dayOfWeek } = getDateInfo(preferred_day);

  // 2. Get qualified technician IDs from indexes
  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${skill}`).once("value");
  const applianceTechsSnap = await db.ref(`/techniciansByAppliance/${appliance}`).once("value");

  if (!skilledTechsSnap.exists() || !applianceTechsSnap.exists()) {
      return res.status(200).send({ slots: [] }); // No techs with that skill/appliance
  }

  const skilledTechs = Object.keys(skilledTechsSnap.val());
  const applianceTechs = Object.keys(applianceTechsSnap.val());
  const potentialTechIds = skilledTechs.filter(id => applianceTechs.includes(id));
  
  let allAvailableSlots = [];

  // 3. Get all appointments for the target date once to be efficient
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  // 4. Loop through potential technicians to calculate slots
  for (const techId of potentialTechIds) {
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();

    // 5. Final filtering by region and working hours
    if (technician && technician.TechRegion === region) {
      const workingHours = technician.working_hours[dayOfWeek];
      if (workingHours && workingHours !== "none") {
        
        // 6. THE CORE LOGIC: Calculate free slots
        const bookedSlots = todaysAppointments[techId] || []; // Get this tech's bookings for the day
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        allAvailableSlots.push(...freeSlots);
      }
    }
  }

  // 7. Return a clean, sorted, unique list of slots
  const uniqueSlots = [...new Set(allAvailableSlots)].sort();
  return res.status(200).send({ slots: uniqueSlots.slice(0, 4) }); // Return up to 4 slots
}

/**
 * Placeholder to create a new appointment record.
 */
async function handleConfirmBooking(req, res) {
    const { dateString, slot, techId, customerInfo } = req.body;
    // Logic to write to the `/appointments/{dateString}/{techId}` path
    // ...
    const ticketId = `TICKET-${Date.now()}`;
    return res.status(200).send({ status: "confirmed", ticketId: ticketId });
}


// --- Helper Functions ---

/**
 * The "ruler" algorithm. Takes working hours (e.g., "09:00-18:00") and a list of
 * booked slots (e.g., [{start: "11:00", end: "12:30"}]) and returns available 2-hour slots.
 */
function calculateFreeSlots(workingHours, bookedSlots) {
  const [workStart, workEnd] = workingHours.split('-').map(timeToMinutes);
  const serviceDuration = 120; // 2 hours in minutes
  let availableSlots = [];
  let currentTime = workStart;

  // Sort booked slots by start time to process them in order
  bookedSlots.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

  for (const booked of bookedSlots) {
    const bookedStart = timeToMinutes(booked.start);
    const bookedEnd = timeToMinutes(booked.end);
    
    // Check for free time *before* the current booking
    while (currentTime + serviceDuration <= bookedStart) {
      availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
      currentTime += serviceDuration;
    }
    // Move current time past this booking
    currentTime = Math.max(currentTime, bookedEnd);
  }

  // Check for free time *after* the last booking until the end of the day
  while (currentTime + serviceDuration <= workEnd) {
    availableSlots.push(`${minutesToTime(currentTime)}-${minutesToTime(currentTime + serviceDuration)}`);
    currentTime += serviceDuration;
  }

  return availableSlots;
}

// Simple time conversion utilities
function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Converts "today", "tomorrow", etc., into a date string and day of the week.
 * This is a simplified version; a real app would use a robust date library.
 */
function getDateInfo(preferredDay) {
    const now = new Date(); // Use server's time
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    
    if (preferredDay.toLowerCase() === 'tomorrow') {
        now.setDate(now.getDate() + 1);
    }
    // Add more logic here for "saturday", "monday", etc.
    
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    
    return {
        dateString: `${year}-${month}-${day}`,
        dayOfWeek: dayNames[now.getDay()]
    };
}