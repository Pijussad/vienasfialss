app.post('/log-activity', async (req, res) => {
  const { username, logDate, steps, workout, workoutDuration, sleep } = req.body;

  // Check if all required fields are present
  if (!username || !steps || !workout || !workoutDuration || !sleep) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // If logDate is provided, use it; otherwise, default to today's date
  const activityDate = logDate ? new Date(logDate) : new Date();

  // Adjust to the local time zone (assuming local time zone is desired)
  const localDate = new Date(activityDate.setHours(0, 0, 0, 0));  // Set to midnight local time
  
  // Convert the local date to UTC by adjusting the timezone offset
  const utcDate = new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60000);  // Convert to UTC

  try {
    // Find an existing log for the user on the selected date in UTC
    const existingLog = await DailyLog.findOne({ 
      username, 
      date: { $gte: utcDate, $lt: new Date(utcDate).setDate(utcDate.getDate() + 1) }
    });

    if (existingLog) {
      // Log already exists, update it
      existingLog.steps = steps;
      existingLog.workout = workout;
      existingLog.workoutDuration = workoutDuration;
      existingLog.sleepHours = sleep;

      // Save the updated log
      const updatedLog = await existingLog.save();

      return res.status(200).json({
        success: true,
        message: 'Activity log updated successfully.',
        updatedLog
      });
    } else {
      // Log does not exist, create a new one
      const newLog = new DailyLog({
        username,
        date: utcDate, // Save the date in UTC
        steps,
        workout,
        workoutDuration,
        sleepHours: sleep
      });

      // Save the new log
      const savedLog = await newLog.save();

      return res.status(201).json({
        success: true,
        message: 'Activity log created successfully.',
        savedLog
      });
    }
  } catch (error) {
    console.error('Error logging activity:', error);
    res.status(500).json({ error: 'Server error while logging activity.' });
  }
});
