/**
 * An error whose message is meant for the person who made the request. Any
 * other error is the backend's own failure: its detail goes to the log, and
 * the caller is told only that it failed — the database's wording can name
 * tables and constraints, and the survey is public.
 */
export class UserError extends Error {}
