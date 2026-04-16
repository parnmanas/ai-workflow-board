# Testing Patterns

**Analysis Date:** 2026-04-08

## Test Framework

**Status:** Not detected

**Finding:** No test framework is configured in this codebase.

- **Runner:** None
- **Assertion Library:** None
- **Test files:** Zero `.spec.ts`, `.test.ts`, or test directories found across `apps/`
- **Configuration:** No `jest.config.ts`, `vitest.config.ts`, `karma.conf.js`, or similar files present
- **Package.json scripts:** No test scripts in either `apps/server/package.json` or `apps/client/package.json`

**Run Commands:**
```bash
# No test commands available
# Testing must be added as a future enhancement
```

## Test File Organization

**Current State:** Not applicable — no tests implemented

**Recommended Pattern (for future implementation):**
- **Location:** Co-located with source code
  - Server tests: `apps/server/src/**/__tests__/**/*.spec.ts` or `apps/server/src/**/*.spec.ts`
  - Client tests: `apps/client/src/**/__tests__/**/*.spec.tsx` or `apps/client/src/**/*.spec.tsx`
- **Naming:** `[feature].spec.ts` or `[component].spec.tsx` matching source file names
- **Structure:** One test file per source file

## Test Structure

**Recommended Pattern for Server (NestJS):**
```typescript
describe('ClassName', () => {
  let service: ServiceName;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [ServiceName],
    }).compile();
    service = module.get<ServiceName>(ServiceName);
  });

  describe('methodName', () => {
    it('should return expected result', async () => {
      const result = await service.methodName();
      expect(result).toEqual(expectedValue);
    });
  });
});
```

**Recommended Pattern for Client (React):**
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthProvider } from '../contexts/AuthContext';
import Component from '../components/Component';

describe('Component', () => {
  it('should render correctly', () => {
    render(<Component />);
    expect(screen.getByText('Expected text')).toBeInTheDocument();
  });

  it('should handle user interaction', () => {
    render(<Component />);
    fireEvent.click(screen.getByRole('button'));
    // Assert expected behavior
  });
});
```

## Mocking

**Framework:** Not configured

**Recommended Framework:** Jest with `@nestjs/testing` for server, `vitest` or Jest for client

**Patterns (recommended for future implementation):**

**Server Mock Pattern:**
```typescript
// Mock repository
const mockRepository = {
  find: jest.fn().mockResolvedValue([...]),
  findOne: jest.fn().mockResolvedValue(...),
  save: jest.fn().mockResolvedValue(...),
  delete: jest.fn().mockResolvedValue(...),
};

// Mock service dependency
const mockService = {
  methodName: jest.fn().mockResolvedValue(result),
};
```

**Client Mock Pattern:**
```typescript
// Mock API calls
jest.mock('../api', () => ({
  api: {
    getBoard: jest.fn().mockResolvedValue(boardData),
    createTicket: jest.fn().mockResolvedValue(ticketData),
  },
}));

// Mock context
const mockUseAuth = {
  user: mockUser,
  isAuthenticated: true,
  logout: jest.fn(),
};
jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth,
}));
```

## Fixtures and Factories

**Current State:** Not implemented

**Recommended Pattern (for future implementation):**

```typescript
// apps/server/src/__tests__/fixtures/user.fixture.ts
export const createMockUser = (overrides?: Partial<User>): User => ({
  id: 'mock-user-id',
  name: 'Test User',
  email: 'test@example.com',
  role: 'user',
  password_hash: 'hashed-password',
  ...overrides,
});

export const createMockBoard = (overrides?: Partial<Board>): Board => ({
  id: 'mock-board-id',
  name: 'Test Board',
  workspace_id: 'mock-workspace-id',
  columns: [],
  ...overrides,
});

// apps/client/src/__tests__/fixtures/ticket.fixture.ts
export const createMockTicket = (overrides?: Partial<Ticket>): Ticket => ({
  id: 'mock-ticket-id',
  title: 'Test Ticket',
  description: 'Test description',
  priority: 'medium',
  status: 'todo',
  column_id: 'mock-column-id',
  parent_id: null,
  ...overrides,
});
```

**Location (recommended):**
- Server: `apps/server/src/__tests__/fixtures/`
- Client: `apps/client/src/__tests__/fixtures/`

## Coverage

**Requirements:** Not enforced

**Status:** No coverage tracking configured

**View Coverage (for future implementation):**
```bash
npm run test -- --coverage  # Jest
npm run test -- --coverage  # Vitest
```

**Recommended targets when testing is implemented:**
- Statements: 70%+
- Branches: 60%+
- Functions: 70%+
- Lines: 70%+

## Test Types

### Unit Tests (Recommended for Priority)

**Scope and Approach:**
- **Server Services:** Test business logic in isolation
  - Test each public method with various inputs
  - Mock repository dependencies
  - Validate error handling and edge cases
  - Location: `apps/server/src/services/**/*.spec.ts`
  - Example: `AuthService.login()`, `ActivityService.logAction()`

- **Client Hooks:** Test React hooks with mock API calls
  - Test hook state updates
  - Test error handling
  - Mock useContext and API calls
  - Location: `apps/client/src/hooks/**/*.spec.ts`
  - Example: `useBoard.ts` refresh logic, event listener management

- **Utilities:** Test helper functions like `parseTicket()`, `parseComments()`
  - Input → output transformation
  - Edge cases (empty arrays, null values)
  - Location: `apps/server/src/modules/**/*.spec.ts`

### Integration Tests (Secondary Priority)

**Scope and Approach:**
- **NestJS Controllers:** Test request handling with mocked repositories
  - Test HTTP status codes
  - Test request/response transformation
  - Test guard behavior (auth, permissions)
  - Location: `apps/server/src/modules/{feature}/**/*.spec.ts`
  - Example: `BoardsController` endpoints with TypeORM repository mocks

- **React Context + Components:** Test context providers with mocked API
  - Test provider state management
  - Test component interaction with context
  - Location: `apps/client/src/contexts/**/*.spec.tsx`
  - Example: `AuthContext` login/logout flow, `ToastContext` message display

### E2E Tests (Not Currently Planned)

**Framework:** Not used

**Recommendation:** Consider Cypress or Playwright for critical user flows once test infrastructure is in place.

## Current Testing State

**Critical Gap:** No testing infrastructure exists.

**Impact Areas Without Tests:**
- **Authentication flow:** Login, token management, session validation
  - Files: `apps/server/src/services/auth.service.ts`, `apps/client/src/contexts/AuthContext.tsx`
- **Permission guards:** Authorization checks on protected routes
  - Files: `apps/server/src/common/guards/permission.guard.ts`
- **Complex parsing:** JSON field parsing in controllers
  - Files: `apps/server/src/modules/tickets/tickets.controller.ts` (parseTicket, parseComments)
- **Real-time updates:** SSE event handling and debouncing
  - Files: `apps/client/src/hooks/useBoard.ts` (EventSource management)
- **API integration:** HTTP request handling, error responses
  - Files: `apps/client/src/api.ts`

## Recommended Testing Roadmap

**Phase 1 (Foundation):**
1. Set up Jest for server, Vitest for client
2. Create fixture factories for common entities
3. Write unit tests for critical services (`AuthService`, `LogService`, `ActivityService`)

**Phase 2 (Core Features):**
4. Test NestJS controllers with mocked repositories
5. Test React hooks (`useBoard`, authentication)
6. Test context providers (`AuthContext`, `ToastContext`)

**Phase 3 (Coverage):**
7. Component tests for critical UI (TicketDetail, Board, Column)
8. Integration tests for multi-step flows
9. Set up CI/CD test runs on pull requests

---

*Testing analysis: 2026-04-08*
