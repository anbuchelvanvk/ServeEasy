const express = require('express');
const admin = require('firebase-admin');
const chrono = require('chrono-node');


try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://serveeasy-8565e-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
} catch (error) {
  console.error("Firebase initialization failed. Make sure your FIREBASE_SERVICE_ACCOUNT_JSON environment variable is set correctly.", error);
}

const db = admin.database();
const app = express();
app.use(express.json());

app.use(express.static('public'));

app.get('/TechnicianPortal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'technician_portal.html'));
});

app.post('/api/handler', async (req, res) => {
  const task = req.body.task;
  console.log(`\n--- Received task: ${task} ---`);
  
  try {
    switch (task) {
      case "findAvailableSlots":
        return await handleFindAvailableSlots(req, res);

      case "createTicket":
        return await handleCreateTicket(req, res);
      case "getTicket":
        return await handleGetTicket(req, res);
      case "updateTicket":
        return await handleUpdateTicket(req, res);
      case "cancelTicket":
        return await handleCancelTicket(req, res);

      case "getCustomerByPhone":
        return await handleGetCustomerByPhone(req, res);
      case "getRegionByKey":
        return await handleGetRegionByKey(req, res);

      default:
        return res.status(200).send({ error: "Invalid task specified" });
    }
  } catch (error) {
    console.error(`Error processing task "${task}":`, error);
    return res.status(200).send({ error: "An internal server error occurred." });
  }
});

// This function handles finding available slots based on input criteria
async function handleFindAvailableSlots(req, res) {
  console.log("--- Starting findAvailableSlots: Task received ---");
  const { region, skill, appliance, preferred_time_phrase, custPhone } = req.body;
  
  const normalizedSkill = skill ? skill.toLowerCase() : null;
  const normalizedAppliance = appliance ? appliance.toUpperCase() : null;
  const normalizedRegion = region ? region.toLowerCase() : null;
  console.log("1. Normalized Inputs:", { normalizedRegion, normalizedSkill, normalizedAppliance, preferred_time_phrase, custPhone });

  const dateInfo = getDateInfo(preferred_time_phrase);
  if (!dateInfo) {
    console.log("-! Edge Case Handled: Invalid or past date specified.");
    return res.status(200).send({ slots: [], error: "Invalid or past date specified. Please provide a future date." });
  }
  const { dateString, dayOfWeek, timeWindow } = dateInfo;
  console.log("2. Calculated Date Info:", { dateString, dayOfWeek, timeWindow });

  const skilledTechsSnap = await db.ref(`/techniciansBySkill/${normalizedSkill}`).once("value");
  if (!skilledTechsSnap.exists()) {
    const reason = `No technicians found with the skill '${normalizedSkill}'.`;
    console.log("3. Skill Lookup:", reason);
    return res.status(200).send({ slots: [], error: reason });
  }
  const potentialTechIds = Object.keys(skilledTechsSnap.val());
  console.log("3. Skill Lookup: Found potential technicians:", potentialTechIds);
  
  let allAvailableSlots = [];
  const appointmentsSnap = await db.ref(`/appointments/${dateString}`).once("value");
  const todaysAppointments = appointmentsSnap.val() || {};

  for (const techId of potentialTechIds) {
    const techSnap = await db.ref(`/technicians/${techId}`).once("value");
    const technician = techSnap.val();
    if (!technician) continue;

    const regionMatch = technician.TechRegion.toLowerCase() === normalizedRegion;
    const applianceMatch = Array.isArray(technician.appliances_supported) && technician.appliances_supported.includes(normalizedAppliance);

    if (regionMatch && applianceMatch) {
      const workingHours = technician.working_hours[dayOfWeek];
      if (workingHours && workingHours !== "none") {
        const techAppointmentsObject = todaysAppointments[techId] || {};
        const bookedSlots = Object.values(techAppointmentsObject);
        const freeSlots = calculateFreeSlots(workingHours, bookedSlots);
        for (const slotTime of freeSlots) {
          allAvailableSlots.push({ time: slotTime, techId: techId, techName: technician.TechName });
        }
      }
    }
  }

  const filteredSlots = allAvailableSlots.filter(slot => {
    const slotStart = timeToMinutes(slot.time.split('-')[0]);
    return slotStart >= timeWindow.start && slotStart < timeWindow.end;
  });
  
  if (filteredSlots.length === 0) {
      const reason = "No available appointments were found for the requested skill, region, and time frame.";
      console.log("4. Final Result:", reason);
      return res.status(200).send({ slots: [], error: reason });
  }

  const finalResponseObject = { slots: filteredSlots.slice(0, 4) };
  console.log("4. Final Result: Sending available slots to agent:", finalResponseObject);
  
  return res.status(200).send(finalResponseObject);
}


// This function handles creating a new service ticket based on provided details
async function handleCreateTicket(req, res) {
  const { dateString, slot, customerInfo, jobInfo } = req.body;
  console.log(`--- Starting createTicket for Customer: ${customerInfo.phone} ---`);

  if (!dateString || !slot || !customerInfo || !jobInfo || !jobInfo.requestType || !jobInfo.appliance) {
    return res.status(200).send({ error: "Missing required booking information." });
  }

  const techSnap = await db.ref(`/technicians/${slot.techId}`).once("value");
  if (!techSnap.exists()) {
    return res.status(200).send({ error: "Technician details could not be found." });
  }
  const technician = techSnap.val();

  const ticketId = `SR-${Date.now()}`;
  const [startTime, endTime] = slot.time.split('-');
  
  const ticketData = {
    ticketId, status: "Booked", createdAt: new Date().toISOString(),
    CustName: customerInfo.name, CustPhone: customerInfo.phone, CustAddress: customerInfo.address,
    requestType: jobInfo.requestType,
    appliance: jobInfo.appliance,
    description: jobInfo.description,
    urgency: jobInfo.urgency || "Normal",
    TechId: slot.techId, TechName: technician.TechName, TechPhone: technician.TechPhone,
    appointmentDate: dateString, appointmentTime: slot.time,
  };

  if (jobInfo.requestType === "Installation" && jobInfo.modelInfo) {
    ticketData.modelInfo = jobInfo.modelInfo;
  }

  const appointmentPointer = { start: startTime, end: endTime, ticketId };
  const updates = {};
  const newAppointmentRef = db.ref(`/appointments/${dateString}/${slot.techId}`).push();
  updates[`/tickets/${ticketId}`] = ticketData;
  updates[`/appointments/${dateString}/${slot.techId}/${newAppointmentRef.key}`] = appointmentPointer;

  await db.ref().update(updates);
  console.log(`6. Write successful! Ticket created: ${ticketId}`);
  
  return res.status(200).send({ status: "confirmed", ticketId });
}

// This function handles updating an existing ticket, including rescheduling if needed
async function handleUpdateTicket(req, res) {
  const { ticketId, updates } = req.body;
  console.log(`--- Starting handleUpdateTicket for Ticket ID: ${ticketId} ---`);
  console.log("1. Received updates payload:", updates);

  try {
    if (!ticketId || !updates) {
      return res.status(200).send({ error: "ticketId and updates object are required." });
    }

    const ticketRef = db.ref(`/tickets/${ticketId}`);
    const ticketSnap = await ticketRef.once("value");
    if (!ticketSnap.exists()) {
      return res.status(200).send({ error: "Ticket not found." });
    }

    if (updates.reschedule) {
      console.log("2a. Rescheduling logic triggered.");
      const { newDate, newSlot, oldDate, oldTechId } = updates.reschedule;
      
      const updatesForDatabase = {};
      const oldAppointmentPath = `/appointments/${oldDate}/${oldTechId}`;
      const oldAppointmentsSnap = await db.ref(oldAppointmentPath).orderByChild('ticketId').equalTo(ticketId).once('value');
      
      if (oldAppointmentsSnap.exists()) {
        const oldAppointmentKey = Object.keys(oldAppointmentsSnap.val())[0];
        updatesForDatabase[`${oldAppointmentPath}/${oldAppointmentKey}`] = null;
        console.log(`   - Marked old appointment for deletion.`);
      }
      const [newStartTime, newEndTime] = newSlot.time.split('-');
      updatesForDatabase[`/tickets/${ticketId}/appointmentDate`] = newDate;
      updatesForDatabase[`/tickets/${ticketId}/appointmentTime`] = newSlot.time;
      updatesForDatabase[`/tickets/${ticketId}/TechId`] = newSlot.techId;
      updatesForDatabase[`/tickets/${ticketId}/TechName`] = newSlot.techName;
      const newAppointmentPointer = { start: newStartTime, end: newEndTime, ticketId };
      const newAppointmentRef = db.ref(`/appointments/${newDate}/${newSlot.techId}`).push();
      updatesForDatabase[`/appointments/${newDate}/${newSlot.techId}/${newAppointmentRef.key}`] = newAppointmentPointer;
      await db.ref().update(updatesForDatabase);
      console.log(`3. Reschedule complete.`);
      return res.status(200).send({ status: "rescheduled", ticketId });

    } else {
      console.log("2b. Simple update logic triggered.");

      const { reschedule, ...cleanUpdates } = updates;

      await ticketRef.update(cleanUpdates);
      console.log(`3. Simple update complete.`);
      return res.status(200).send({ status: "updated", ticketId });
    }
  } catch (error) {
    console.error(`-! CRITICAL ERROR during update for ticket ${ticketId}:`, error);
    return res.status(200).send({ error: "An internal server error occurred during the update." });
  }
}

// Retrieves customer details by phone number
async function handleGetTicket(req, res) {
    const { ticketId } = req.body;
    console.log(`Fetching ticket: ${ticketId}`);
    const ticketSnap = await db.ref(`/tickets/${ticketId}`).once("value");
    if (!ticketSnap.exists()) return res.status(200).send({ error: "Ticket not found." });
    return res.status(200).send({ ticket: ticketSnap.val() });
}

async function handleUpdateTicket(req, res) {
    const { ticketId, updates } = req.body;
    console.log(`Updating ticket ${ticketId} with:`, updates);
    const ticketRef = db.ref(`/tickets/${ticketId}`);
    await ticketRef.update(updates);
    return res.status(200).send({ status: "updated", ticketId });
}

// Cancels a ticket by setting its status to "Cancelled"
async function handleCancelTicket(req, res) {
    const { ticketId } = req.body;
    console.log(`Cancelling ticket: ${ticketId}`);

    const ticketRef = db.ref(`/tickets/${ticketId}`);
    await ticketRef.update({ status: "Cancelled" });

    return res.status(200).send({ status: "cancelled", ticketId });
}

// Helper Functions


// Calculate available slots given working hours and booked slots
// Uses Ruler's algorithm to find gaps
function calculateFreeSlots(workingHours, bookedSlots) {
  const [workStart, workEnd] = workingHours.split('-').map(timeToMinutes);
  const serviceDuration = 120; 
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

// Parses a natural language date phrase and returns structured date info
function getDateInfo(phrase) {
  const referenceDate = new Date();
  let targetDate;

  const dmyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
  const match = phrase.match(dmyRegex);

  if (match) {

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; 
    const year = parseInt(match[3], 10);
    targetDate = new Date(year, month, day);
  } else {
 
    const parsedResult = chrono.parse(phrase, referenceDate, { forwardDate: true });
    if (!parsedResult || parsedResult.length === 0) {
        console.log("Error: Could not understand the date phrase:", phrase);
        return null;
    }
    targetDate = parsedResult[0].start.date();
  }


  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (targetDate < startOfToday) {
      console.log("Error: Requested date is in the past.");
      return null;
  }
    
  const timeWindows = {
      morning: { start: 9 * 60, end: 12 * 60 },
      afternoon: { start: 12 * 60, end: 17 * 60 },
      evening: { start: 17 * 60, end: 21 * 60 }
  };

  let timeWindow = { start: 0, end: 24 * 60 }; 
  const phraseLower = (phrase || "").toLowerCase();
  if (phraseLower.includes('morning')) timeWindow = timeWindows.morning;
  if (phraseLower.includes('afternoon')) timeWindow = timeWindows.afternoon;
  if (phraseLower.includes('evening')) timeWindow = timeWindows.evening;
    
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    
  return {
      dateString: `${targetDate.getFullYear()}-${(targetDate.getMonth() + 1).toString().padStart(2, '0')}-${targetDate.getDate().toString().padStart(2, '0')}`,
      dayOfWeek: dayNames[targetDate.getDay()],
      timeWindow: timeWindow
  };
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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});