/** Throwaway users for the fake app in the auth examples (not real credentials). */
export const USERS: Record<string, string> = {
    'admin@example.test': 'admin-pw',
    'viewer@example.test': 'viewer-pw',
};

/** The auth config the browser examples use: one role per user, state kept apart from real runs. */
export const EXAMPLE_AUTH = {
    stateDir: '.auth/examples',
    roles: {
        admin: { username: 'admin@example.test', password: USERS['admin@example.test'] },
        viewer: { username: 'viewer@example.test', password: USERS['viewer@example.test'] },
    },
};
