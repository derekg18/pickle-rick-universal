# BDD Scenarios for Pickle-Dot Codegen Builder
# Generated from pipeline author perspective

## Scenario 1: Empty Slug Rejection
**Given** a pipeline author who omits the slug field
**When** the builder processes the spec with an empty string slug
**Then** it rejects with a clear EMPTY_SLUG error explaining what was missing
**And** the error message indicates that slug is a required non-empty field

## Scenario 2: Duplicate Phase Sanitization Collision
**Given** a pipeline author who defines two phases with names that sanitize to the same ID
**When** the builder processes the spec with phases like "auth scan" and "auth-scan"
**Then** it rejects with DUPLICATE_PHASE identifying the collision
**And** the diagnostic message shows the sanitized ID that caused the collision ("auth_scan")
**And** the error is thrown at the second `.phase()` call

## Scenario 3: Single-Phase Pipeline Structure
**Given** a pipeline author who defines a single-phase pipeline
**When** the builder generates the DOT output
**Then** the output contains a valid digraph with Mdiamond start node
**And** the output contains a valid Msquare exit node
**And** the start node has no incoming edges
**And** the exit node has exactly one incoming edge from verify_final

## Scenario 4: Already Built Rejection
**Given** a pipeline author who has successfully built a pipeline
**When** the builder attempts to call .build() again on the same instance
**Then** it rejects with ALREADY_BUILT error
**And** the instance is consumed after first build (single-use semantics)

## Scenario 5: Special Character Sanitization
**Given** a pipeline author who uses special characters in phase names
**When** the builder sanitizes them for DOT node IDs
**Then** the resulting DOT node IDs are valid identifiers matching `[a-zA-Z_][a-zA-Z0-9_]*`
**And** phase name "auth scan" becomes node ID "auth_scan"
**And** phase name "auth-scan" becomes node ID "auth_scan"
**And** consecutive underscores are collapsed (e.g., "auth__scan" → "auth_scan")
**And** leading/trailing underscores are stripped

## Scenario 6: Special Character Escaping in DOT
**Given** a pipeline author whose prompt text contains quotes and newlines
**When** the builder emits DOT
**Then** all special characters are properly escaped in the output
**And** backslashes are escaped as `\\`
**And** double quotes are escaped as `\"`
**And** newlines are escaped as literal `\n` (backslash followed by n)
**And** carriage returns are escaped as `\r`
**And** the resulting attribute value is wrapped in double quotes
