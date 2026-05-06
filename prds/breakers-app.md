# Soccer Club App PRD
| Soccer Club App PRD | | Custom communication app replacing Band App |
|:---|:---|:---|
| **Author**: Derek | **Status**: Draft **Created**: 2026-05-06 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction 
- [x] Problem 
- [x] Scope 
- [x] CUJs 
- [x] Requirements 
- [x] Contracts 
- [x] Verification 
- [x] Tests 
- [x] Assumptions 
- [x] Risks 
- [x] Impact 
- [x] Stakeholders

## Introduction
A custom communication application for a soccer club to facilitate communication between managers, coaches, and parents, replacing the existing reliance on Band App. The app will be built natively for iOS, macOS, Windows, and provide web integration via Squarespace.

## Problem Statement
**Current Process**: The club uses the Band App for communications, which involves separate groups for teams, staff/coaches, and coaches.
**Users**: Managers, Coaches, Parents, Staff.
**Pain Points**: Band App is a generic 3rd-party solution. The club desires a branded, unified, custom experience without relying on a disconnected platform, bridging native apps with their Squarespace website.
**Importance**: Enhances club branding, centralized data ownership, and improves tailored user experience for scheduling and real-time chat.

## Objective & Scope
**Objective**: Build a multi-platform native communication application integrated with Firebase backend and Google Calendars.
**Ideal Outcome**: Seamless chat, RSVP, scheduling, and announcement capabilities across iOS (SwiftUI), macOS (SwiftUI), Windows (C#), and web (Firebase Web SDK embedded in Squarespace).

### In-scope
- Real-time Chat (Team groups, Staff/Coaches, Coaches-only)
- Announcements channel
- Scheduling (Integrated with Google Calendar)
- RSVPs for events
- Native apps: iOS/macOS (Swift/SwiftUI), Windows (C#)
- Backend: Firebase (Authentication, Firestore, Cloud Messaging)

### Not-in-scope
- File sharing (deferred to a later phase)
- Custom complex web backend server (utilizing Firebase instead)

## Product Requirements

### Critical User Journeys (CUJs)
1. **Coach scheduling**: A coach creates an event/practice synced with Google Calendar, notifying parents.
2. **Parent RSVP**: A parent receives an announcement/schedule update and RSVPs (Yes/No).
3. **Team Chat**: A manager sends a real-time message to the specific Team group, triggering push notifications.

### Functional Requirements
| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | Role-based Auth | As a user, I can log in via Firebase Auth and see only my groups. | Firestore security rule test checking role access. |
| P0 | Real-time Chat | As a parent/coach, I can send and receive messages instantly. | Firebase emulator integration test verifying document creation triggers listener. |
| P0 | Announcements | As a manager, I can broadcast messages to all team members. | XCTest/NUnit verifying UI displays announcement feeds. |
| P0 | Scheduling & RSVPs | As a coach, I can link Google Calendar events and users can RSVP. | Mocked Google API test & Firestore RSVP document check. |
| P1 | Push Notifications | As a user, I am notified of new chats or announcements. | FCM payload validation test. |

## Interface Contracts

### API Contracts
Direct Firebase SDK usage via Firestore. 
| Endpoint/Function | Input | Output | Error | Contract Test |
|:---|:---|:---|:---|:---|
| `sendMessage(groupId)` | `Message` | `void` | `PermissionDenied` | Firestore Rule test suite |
| `updateRSVP(eventId)` | `RSVPStatus` | `void` | `NotFound` | Firestore Rule test suite |

### Type Contracts
Firestore Document Schemas:
- **User**: `{ uid: string, role: 'coach'|'manager'|'parent'|'staff', teamIds: string[] }`
- **Group**: `{ id: string, name: string, type: 'team'|'staff'|'coaches', memberIds: string[] }`
- **Message**: `{ id: string, groupId: string, senderId: string, text: string, timestamp: timestamp }`
- **Event (Sync from GCal)**: `{ id: string, title: string, date: timestamp, groupId: string }`
- **RSVP**: `{ id: string, eventId: string, userId: string, status: 'attending'|'declined' }`

### State Transitions
| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| Logged Out | Login Success | Authenticated | Firebase SDK initializes | User has assigned roles |
| No RSVP | Parent taps "Attending" | RSVP Attending | Updates Firestore, notifies Coach | 1 RSVP per user per event |

## Verification Strategy
- **Type**: Swift/C# static type checking passes.
- **Lint**: SwiftLint (Apple) and Roslyn analyzers (Windows) pass.
- **Test**: XCTest for Apple, NUnit for Windows, Jest for Firebase Rules.
- **Contract**: Firestore rules validated via Firebase Local Emulator Suite.

### Verification Commands
| Check | Command | Expected |
|:---|:---|:---|
| Apple Tests | `xcodebuild test -project SoccerClub.xcodeproj -scheme iOSApp -destination 'platform=iOS Simulator,name=iPhone 15'` | `** TEST SUCCEEDED **` |
| Windows Tests | `dotnet test SoccerClub.Windows.sln` | `Passed!` |
| Firebase Rules | `firebase emulators:exec "npm test"` | All rule tests pass |

## Test Expectations

### Unit Tests
| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Auth State | `AuthTests.swift`/`AuthTests.cs` | Validate UI changes upon login | Assert Home view is presented |
| RSVP Logic | `RSVPViewModelTests.swift` | Submitting RSVP updates local state | Assert status == .attending |

### Integration Tests
| CUJ | Test File | Scenario | Expected |
|:---|:---|:---|:---|
| Team Chat | `ChatIntegrationTests.swift` | Send message to Firestore emulator | Listener fires with new message |

### Edge Cases
| Condition | Behavior | Test |
|:---|:---|:---|
| Offline Chat | Message queues locally and syncs when online | Firebase offline persistence test |
| Conflicting RSVPs| Last write wins | Rapid concurrent toggle test |

## Assumptions
- The organization has a Google Workspace or Google Calendars setup that can be accessed via API.
- Firebase Blaze plan will be utilized for external API calls (if calling GCal from Cloud Functions).
- Squarespace can embed a React/JS Firebase web component.

## Risks & Mitigations
- **Risk**: Google Calendar bi-directional sync complexity. **Mitigation**: Start with read-only view of events inside the app, and handle RSVPs in our Firebase DB, not directly in GCal.
- **Risk**: Maintaining native apps across 3 ecosystems (iOS, macOS, Windows). **Mitigation**: Share architectural patterns (MVVM) heavily.

## Tradeoffs
- Chose Native Swift/C# over React Native/Flutter to ensure highest performance and adhere to the "no scripting language" constraint, trading off faster development time for native quality.

## Business Impact
| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Band App Usage | 100% | 0% | Full migration to owned platform |
| Comm Engagement | Baseline | +20% | Centralized and streamlined |

## Stakeholders
| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Derek | Engineering | Lead | Implementing Firebase & Native apps |
| Web Dev | Web | Member | Embedding on Squarespace |