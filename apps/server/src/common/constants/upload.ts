// Shared image upload validation constants.
// Used by chat-rooms controller (message images).
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_IMAGES_PER_MESSAGE = 5;
export const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Comment attachments — any mimetype (treated as Resource rows), larger cap
// than chat images because users drop PDFs/zips alongside screenshots.
export const MAX_COMMENT_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_COMMENT_ATTACHMENTS = 5;
