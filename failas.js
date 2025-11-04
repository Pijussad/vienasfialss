// Helper function to map app's task object to the database format
function mapTaskToDbFormat(task, userId, newModifiedAt) {
    // Fixes "nested ternary" smell and centralizes mapping
    let actualTimeValue = null;
    if (typeof task.actualTime === 'number') {
        actualTimeValue = task.actualTime;
    }

	return {
		id: task.id,
		user_id: userId,
		title: task.title,
		description: task.description || '',
		type: task.type || 'General',
		lane: task.lane,
		priority: task.priority,
		order: task.order,
		due_date: task.dueDate || null,
		completed: task.completed,
		completed_at: task.completedAt || null,
		length: task.length || 0,
		actual_time: actualTimeValue,
		repeat_days: task.repeatDays || [],
		dismissed_dates: task.dismissedDates || [],
		is_repeating_instance: task.isRepeatingInstance || false,
		repeat_source_id: task.repeatSourceId || null,
		streak: task.streak || 0,
		subtasks: task.subtasks || [],
		created_at: task.createdAt,
		modified_at: newModifiedAt,
	};
}

// Dedicated function for saving user's own tasks with conflict resolution
async function saveOwnTasks(tasks, user) {
    if (tasks.length === 0) return;

    // STEP 1 & 1.5: Fetch server state for conflict detection (can be further refactored)
    const taskIds = tasks.map(t => t.id);
    const { data: serverTasks } = await window.supabaseClient.from('tasks').select('id, modified_at').in('id', taskIds);
    const serverMap = new Map(serverTasks?.map(t => [t.id, t]) || []);

    // STEP 2: Filter tasks to save only if local is newer
    const tasksToUpsert = tasks.filter(task => {
        const serverTask = serverMap.get(task.id);
        if (!serverTask) return true; // New task
        const localModified = new Date(task.modifiedAt || task.createdAt).getTime();
        const serverModified = new Date(serverTask.modified_at).getTime();
        return localModified >= serverModified;
    });

    if (tasksToUpsert.length === 0) {
        console.log(`⏭️ All own tasks skipped (server has newer versions)`);
        return;
    }
    
    // STEP 3: Save tasks
    const newModifiedAt = new Date().toISOString();
    const dbOwnTasks = tasksToUpsert.map(task => mapTaskToDbFormat(task, user.id, newModifiedAt));
    
    const { error: ownError } = await window.supabaseClient.from('tasks').upsert(dbOwnTasks, { onConflict: 'id' });

    // STEP 4: Handle specific errors
    if (ownError) {
        if (ownError.code === '23505') { // Unique constraint violation
            console.warn('🔄 Duplicate repeating instance detected - this is acceptable.');
        } else {
            console.error('❌ Failed to save own tasks:', ownError);
            throw ownError;
        }
    }
}

// Dedicated function for saving shared tasks
async function saveSharedTasks(tasks) {
    if (tasks.length === 0) return;

    const updatePromises = tasks.map(async (task) => {
        const newModifiedAt = new Date().toISOString();
        const dbTask = mapTaskToDbFormat(task, task.ownerId, newModifiedAt);

        const { error } = await window.supabaseClient.from('tasks').update(dbTask).eq('id', task.id);
        if (error) {
            console.error(`Failed to save shared task ${task.id}:`, error);
        }
        return error;
    });

    await Promise.all(updatePromises);
}
