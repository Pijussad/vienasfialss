app.post('/log-activity', async (req, res) => {
  const { username, logDate, steps, workout, workoutDuration, sleep } = req.body;

  if (!username || !steps || !workout || !workoutDuration || !sleep) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const activityDate = logDate ? new Date(logDate) : new Date();
  const localDate = new Date(activityDate.setHours(0, 0, 0, 0));
  const utcDate = new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60000);

  try {
    const existingLog = await DailyLog.findOne({ 
      username, 
      date: { $gte: utcDate, $lt: new Date(utcDate).setDate(utcDate.getDate() + 1) }
    });

    if (existingLog) {
      existingLog.steps = steps;
      existingLog.workout = workout;
      existingLog.workoutDuration = workoutDuration;
      existingLog.sleepHours = sleep;
      const updatedLog = await existingLog.save();
      return res.status(200).json({
        success: true,
        message: 'Activity log updated successfully.',
        updatedLog
      });
    } else {
      const newLog = new DailyLog({
        username,
        date: utcDate,
        steps,
        workout,
        workoutDuration,
        sleepHours: sleep
      });
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
