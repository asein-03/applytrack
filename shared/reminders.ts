export interface ReminderPreferences {
  enabled: boolean;
  leadMinutes: number;
  timeZone: string | null;
  dateOnlyTime: string;
}
export const DEFAULT_REMINDER_PREFERENCES: ReminderPreferences = {
  enabled: false, leadMinutes: 1440, timeZone: null, dateOnlyTime: '09:00',
};
export interface ReminderItem {
  id: string;
  applicationId: string;
  taskId: string;
  title: string;
  company: string;
  role: string;
  dueAt: string;
  scheduledAt: string;
  snoozedUntil: string | null;
  deliveredAt: string | null;
  status: 'upcoming' | 'due' | 'snoozed' | 'notified';
}
export interface ReminderSnapshot {
  preferences: ReminderPreferences;
  items: ReminderItem[];
  serverTime: string;
}
export interface ReminderDelivery extends ReminderItem { leaseId: string; leaseExpiresAt: string; }

export const PRIVATE_REMINDER_NOTIFICATION = {
  title: 'Application deadline',
  body: 'Open ApplyTrack to view your next task.',
} as const;
