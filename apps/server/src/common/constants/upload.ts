// Shared image upload validation constants.
// Used by chat-rooms controller (message images).
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_IMAGES_PER_MESSAGE = 5;
export const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Comment attachments — any mimetype (treated as Resource rows), larger cap
// than chat images because users drop PDFs/zips alongside screenshots.
export const MAX_COMMENT_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_COMMENT_ATTACHMENTS = 5;

// Ticket-level attachments — stored inline on the ticket_attachments table
// (NOT through the Resource indirection that comment uploads use). Same
// 10MB cap as comments; per-ticket count cap is generous because tickets
// often collect spec PDFs, screenshots, sample inputs, etc.
export const MAX_TICKET_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_TICKET_ATTACHMENTS = 20;
