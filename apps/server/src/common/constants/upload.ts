// Shared image upload validation constants.
// Used by tickets controller (comment images) and chat-rooms controller (message images).
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_IMAGES_PER_MESSAGE = 5;
export const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
