async function saveTasks(tasks) {
	try {
		// Always save to offline cache first
		saveToOfflineCache(tasks, { silent: true });

		const user = await getCurrentUser();
		if (!user) {
			console.log('Cannot save to cloud: No user logged in');
			return;
		}

		// If offline, add to sync queue
		if (!isOnline()) {
			console.log('📴 Offline - queuing save for sync');
			addToSyncQueue('save', { tasks });
			return;
		}

		// Save tasks that the user owns OR has edit permission for
		// We'll try to save both own tasks and shared tasks with edit permission
		// RLS policies will block saves for view-only shared tasks
		const tasksToSave = tasks.filter(task => {
			// Always include own tasks
			if (!task.isShared && (!task.ownerId || task.ownerId === user.id)) {
				return true;
			}
			// Include only shared tasks the user can edit
			return task.isShared === true && task.canEdit === true;
		});

		if (tasksToSave.length === 0) {
			console.log('No tasks to save');
			return;
		}

		// Split into own and shared for better error handling
		const ownTasks = tasksToSave.filter(t => !t.isShared);
		const sharedTasks = tasksToSave.filter(t => t.isShared && t.canEdit === true);

		// Save own tasks with conflict resolution
		if (ownTasks.length > 0) {
			// STEP 1: Fetch current server state for conflict detection
			const taskIds = ownTasks.map(t => t.id);
			const { data: serverTasks } = await window.supabaseClient
				.from('tasks')
				.select('id, modified_at, repeat_source_id, due_date, is_repeating_instance')
				.in('id', taskIds);

			const serverMap = new Map(serverTasks?.map(t => [t.id, t]) || []);

			// STEP 1.5: Check for repeating instances that might conflict
			const repeatingInstances = ownTasks.filter(t => t.isRepeatingInstance && t.repeatSourceId && t.dueDate);
			if (repeatingInstances.length > 0) {
				// Check if these repeat_source_id + due_date combinations already exist
				const { data: existingInstances } = await window.supabaseClient
					.from('tasks')
					.select('id, repeat_source_id, due_date, modified_at, completed')
					.eq('is_repeating_instance', true)
					.not('repeat_source_id', 'is', null)
					.not('due_date', 'is', null);

				// Create a map of existing instances by repeat_source_id + due_date
				const instanceMap = new Map();
				existingInstances?.forEach(inst => {
					const key = `${inst.repeat_source_id}:${inst.due_date}`;
					instanceMap.set(key, inst);
				});

				// Check each repeating instance against existing ones
				for (const task of repeatingInstances) {
					const key = `${task.repeatSourceId}:${task.dueDate}`;
					const existing = instanceMap.get(key);

					if (existing && existing.id !== task.id) {
						// Another instance with same source+date exists with different ID
						// Add it to serverMap so it gets handled by conflict resolution
						serverMap.set(task.id, {
							id: existing.id,
							modified_at: existing.modified_at,
							repeat_source_id: existing.repeat_source_id,
							due_date: existing.due_date,
							is_repeating_instance: true
						});
						console.log(`🔄 Found existing repeating instance for ${task.repeatSourceId} on ${task.dueDate}`);
					}
				}
			}

			// STEP 2: Filter tasks to only save if local is newer or doesn't exist
			const tasksToUpsert = [];
			const skippedDueToConflict = [];

			for (const task of ownTasks) {
				const serverTask = serverMap.get(task.id);

				if (!serverTask) {
					// Task doesn't exist on server - it's a new task, always save
					tasksToUpsert.push(task);
				} else {
					// Existing task - check if local is newer
					const localModified = new Date(task.modifiedAt || task.createdAt).getTime();
					const serverModified = new Date(serverTask.modified_at).getTime();

					if (localModified >= serverModified) {
						tasksToUpsert.push(task);
					} else {
						skippedDueToConflict.push(task.id);
						// Individual warnings suppressed - see summary below
					}
				}
			}

			if (skippedDueToConflict.length > 0) {
				console.log(`⏭️ Skipped ${skippedDueToConflict.length} tasks (server has newer versions)`);
			}

			// STEP 3: Save tasks that passed conflict check
			if (tasksToUpsert.length > 0) {
				const pendingTimestampUpdates = new Map();
				const dbOwnTasks = tasksToUpsert.map(task => {
					const newModifiedAt = new Date().toISOString();
					pendingTimestampUpdates.set(task.id, newModifiedAt);
					task.modifiedAt = newModifiedAt;
					return {
						id: task.id,
						user_id: user.id,
						title: task.title,
						description: task.description || '',
						type: task.type || 'General',
						lane: task.lane,
						priority: task.priority,
						order: task.order,
						due_date: task.dueDate || null,
						completed: task.completed,
						completed_at: task.completedAt || '',
						length: task.length || 0,
						actual_time: task.actualTime === "" ? null : (typeof task.actualTime === 'number' ? task.actualTime : null),
						repeat_days: task.repeatDays || [],
						dismissed_dates: task.dismissedDates || [],
						is_repeating_instance: task.isRepeatingInstance || false,
						repeat_source_id: task.repeatSourceId || null,
						streak: task.streak || 0,
						subtasks: task.subtasks || [],
						created_at: task.createdAt,
						modified_at: newModifiedAt
					};
				});

				const { data: ownResult, error: ownError } = await window.supabaseClient
					.from('tasks')
					.upsert(dbOwnTasks, {
						onConflict: 'id',
						ignoreDuplicates: false
					})
					.select('id, modified_at');

				if (ownError) {
					// STEP 4: Handle unique constraint violations for repeating instances
					if (ownError.code === '23505' && ownError.message?.includes('unique_repeating_instance')) {
						console.warn('🔄 Duplicate repeating instance detected - another device already created it');

						// Log which repeating instances we tried to save
						const repeatingInstances = tasksToUpsert.filter(t => t.isRepeatingInstance);
						console.log('Repeating instances in this batch:', repeatingInstances.map(t => ({
							title: t.title,
							repeatSourceId: t.repeatSourceId,
							dueDate: t.dueDate
						})));

						// This is OK - the database constraint prevented the duplicate
						// The local array will be corrected on next loadTasks()
					} else {
						console.error('❌ Failed to save own tasks:', ownError);
						console.error('Error code:', ownError.code);
						console.error('Error message:', ownError.message);
						console.error('Error details:', ownError.details);
						console.error('Error hint:', ownError.hint);
						throw ownError;
					}
				} else if (ownResult && ownResult.length > 0) {
					const serverTimestampMap = new Map(ownResult.map(row => [row.id, row.modified_at]));
					tasksToUpsert.forEach(task => {
						const serverTimestamp = serverTimestampMap.get(task.id) || pendingTimestampUpdates.get(task.id);
						if (serverTimestamp) {
							task.modifiedAt = serverTimestamp;
						}
					});
				}
			}

			if (skippedDueToConflict.length > 0) {
				skippedDueToConflict.forEach(id => {
					const serverTask = serverMap.get(id);
					const localTask = tasks.find(t => t.id === id);
					if (serverTask?.modified_at && localTask) {
						localTask.modifiedAt = serverTask.modified_at;
					}
				});
			}
		}

		// Save shared tasks with UPDATE only (not upsert) - they already exist
		if (sharedTasks.length > 0) {
			// Update each shared task individually to avoid INSERT policy issues
			const results = await Promise.all(sharedTasks.map(async task => {
				const newModifiedAt = new Date().toISOString();
				const dbTask = {
					id: task.id,
					user_id: task.ownerId, // Preserve original owner
					title: task.title,
					description: task.description || '',
					type: task.type || 'General',
					lane: task.lane,
					priority: task.priority,
					order: task.order,
					due_date: task.dueDate || null,
					completed: task.completed,
					completed_at: task.completedAt || '',
					length: task.length || 0,
					actual_time: task.actualTime === "" ? null : (typeof task.actualTime === 'number' ? task.actualTime : null),
					repeat_days: task.repeatDays || [],
					dismissed_dates: task.dismissedDates || [],
					is_repeating_instance: task.isRepeatingInstance || false,
					repeat_source_id: task.repeatSourceId || null,
					streak: task.streak || 0,
					subtasks: task.subtasks || [],
					modified_at: newModifiedAt
				};

				const { data, error } = await window.supabaseClient
					.from('tasks')
					.update(dbTask)
					.eq('id', task.id)
					.select('id, modified_at')
					.maybeSingle();

				if (!error) {
					task.modifiedAt = (data && data.modified_at) || newModifiedAt;
				}

				return error;
			}));

			const errors = results.filter(Boolean);

			if (errors.length > 0) {
				console.error('Failed to save some shared tasks:', errors);
				console.log('Shared tasks that failed:', errors.map(e => e.error));
				// Don't throw - partial success is ok for shared tasks
			}
		}

		saveToOfflineCache(tasks);
		console.log(`✅ Saved ${ownTasks.length} own tasks, ${sharedTasks.length} shared tasks`);
	} catch (error) {
		console.error('Error saving tasks:', error);
		throw error;
	}
}
