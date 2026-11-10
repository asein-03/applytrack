import { randomUUID } from 'node:crypto';
import type { Evidence, Stage } from '../shared/types.js';
import { Store } from './store.js';

/** Fictional data lives in its own workspace and is never mixed into personal records. */
export function seedDemo(store: Store): void {
  if (store.getMeta('demoSeeded')) return;
  const offset = (days: number, hour = 16) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + days); value.setUTCHours(hour, 0, 0, 0); return value.toISOString(); };
  const rows: Array<{ company: string; role: string; stage: Stage; location: string; workMode: string; salary: string; days: number; task?: string; due?: number; recruiter?: string }> = [
    { company: 'Northstar', role: 'Product Designer', stage: 'assessment', location: 'New York, NY', workMode: 'Hybrid', salary: '$85,000–$110,000', days: -5, task: 'Complete design assessment', due: 1, recruiter: 'Maya Chen' },
    { company: 'Forma', role: 'Associate Product Manager', stage: 'interviewing', location: 'San Francisco, CA', workMode: 'Hybrid', salary: '$95,000–$120,000', days: -9, task: 'Choose an interview time', due: 0, recruiter: 'Alex Rivera' },
    { company: 'Common Ground', role: 'UX Researcher', stage: 'applied', location: 'Remote, US', workMode: 'Remote', salary: '', days: -3 },
    { company: 'Fieldwork', role: 'Graduate Software Engineer', stage: 'assessment', location: 'Boston, MA', workMode: 'On-site', salary: '$90,000–$115,000', days: -7, task: 'Finish coding assessment', due: 3, recruiter: 'Sam Park' },
    { company: 'Arc Studio', role: 'Junior Visual Designer', stage: 'applied', location: 'Brooklyn, NY', workMode: 'Hybrid', salary: '$70,000–$85,000', days: -2 },
    { company: 'Gather', role: 'Product Operations Associate', stage: 'offer', location: 'Remote, US', workMode: 'Remote', salary: '$78,000–$92,000', days: -18, task: 'Review offer details', due: 5, recruiter: 'Jordan Ellis' },
    { company: 'Daylight', role: 'Customer Insights Analyst', stage: 'saved', location: 'Austin, TX', workMode: 'Hybrid', salary: '', days: 0 },
    { company: 'Parallel', role: 'Graduate Data Analyst', stage: 'rejected', location: 'Chicago, IL', workMode: 'Hybrid', salary: '', days: -14 },
    { company: 'Outline', role: 'Design Engineer', stage: 'in_progress', location: 'Remote, US', workMode: 'Remote', salary: '$100,000–$130,000', days: 0 },
  ];
  store.transaction(() => {
    for (const [index, row] of rows.entries()) {
      let app = store.createApplication({ ...row, workspace: 'demo', url: `https://example.com/jobs/sample-${index + 1}`, jobId: `DEMO-${1000 + index}`, description: `Fictional example for ${row.role} at ${row.company}. Work with a small team to understand customer needs, contribute to product decisions, and build useful experiences. This record is sample data for exploring the tracker.`, email: 'alex@example.com', resumeName: 'Alex_Resume.pdf', coverLetterName: index % 2 === 0 ? 'Cover_Letter.pdf' : '', recruiterName: row.recruiter ?? '', recruiterEmail: row.recruiter ? 'recruiting@example.com' : '', notes: index === 0 ? 'Prepare two recent projects and explain the decisions behind each.' : '', priority: index < 2 ? 'high' : 'normal', appliedAt: ['saved', 'in_progress'].includes(row.stage) ? null : offset(row.days) });
      app.createdAt = offset(row.days);
      app.updatedAt = offset(Math.max(row.days, -index), 14);
      app.timeline = [{ id: randomUUID(), title: 'Application added', detail: 'Example record in the demo workspace.', source: 'manual', createdAt: app.createdAt }];
      if (app.appliedAt) {
        const evidence: Evidence = { id: randomUUID(), applicationId: app.id, source: 'browser', kind: 'submission_confirmed', summary: 'Application submitted', excerpt: 'Your application has been received. Thank you for your interest.', url: app.url, observedAt: app.appliedAt, snapshot: null, review: 'accepted', sourceId: `demo-browser-${index}` };
        app.evidence.push(evidence);
        app.timeline.unshift({ id: randomUUID(), title: 'Application submitted', detail: 'Confirmation detected on the application page.', source: 'browser', createdAt: app.appliedAt });
        app.evidence.push({ ...evidence, id: randomUUID(), source: 'email', summary: 'Confirmation email received', excerpt: `Thank you for applying for the ${row.role} position.`, sourceId: `demo-email-${index}` });
      }
      if (row.task) {
        app.tasks.push({ id: randomUUID(), applicationId: app.id, title: row.task, dueAt: offset(row.due ?? 1), url: `https://example.com/tasks/sample-${index}`, completedAt: null, createdAt: offset(-1) });
        app.timeline.unshift({ id: randomUUID(), title: row.task, detail: 'Next step from the example employer message.', source: 'email', createdAt: offset(-1) });
      }
      if (index === 2) app.evidence.unshift({ id: randomUUID(), applicationId: app.id, source: 'email', kind: 'interview', summary: 'Possible interview invitation', excerpt: 'Would you be available to discuss the role this week?', url: null, observedAt: offset(0, 10), snapshot: null, review: 'pending', sourceId: 'demo-review-1' });
      store.saveApplication(app);
    }
    store.setMeta('demoSeeded', true);
  });
}
