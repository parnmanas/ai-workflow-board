// tree-sitter tags 스타일 쿼리 — `typescript`/`tsx` 문법 공용(ticket e14ef1c9,
// DESIGN.md 축 1). `tree-sitter-typescript`/`tree-sitter-tsx`는 class/함수/
// heritage/method 관련 노드 shape가 동일해서(JSX 관련 노드는 body 표현식
// 안쪽에만 나타나고 def/heritage/import/export 캡처에는 영향 없음) 한 쿼리를
// 공유한다 — `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`(package.json에
// 핀 고정)로 아래 실제 노드 kind/field 이름을 직접 파싱해 검증했다(추측 아님).
// `javascript.ts`는 별도 파일이다 — JS 문법은 `interface`/`type`/`enum`/
// `implements`가 아예 없고, `class_heritage`/필드 정의의 필드 이름도 달라서
// (`public_field_definition name:` vs `field_definition property:`) 쿼리를
// 공유할 수 없다(빈 매치가 아니라 QueryError로 죽는다 — 실제로 검증하며 발견).
//
// 버전이 바뀌면(trap #1, research-extraction.md §6) 이 쿼리도 같이 재검증해야
// 한다 — EXTRACTOR_VERSION(types.ts)이 그 신호다.
export const TYPESCRIPT_FAMILY_TAGS_QUERY = `
(function_declaration name: (identifier) @def.name) @def.function

(class_declaration name: (_) @def.name) @def.class

(interface_declaration name: (_) @def.name) @def.interface

(type_alias_declaration name: (_) @def.name) @def.type

(enum_declaration name: (_) @def.name) @def.enum

(method_definition name: (property_identifier) @def.name) @def.method
(method_signature name: (property_identifier) @def.name) @def.method

(public_field_definition name: (property_identifier) @def.name) @def.field

(variable_declarator name: (identifier) @def.name value: [(arrow_function) (function_expression)]) @def.arrow

(class_declaration
  name: (_) @heritage.class_name
  (class_heritage
    (extends_clause value: (_) @heritage.extends_target)))

(class_declaration
  name: (_) @heritage.class_name
  (class_heritage
    (implements_clause (_) @heritage.implements_target)))

(interface_declaration
  name: (_) @heritage.class_name
  (extends_type_clause (_) @heritage.extends_target))

(import_clause (named_imports (import_specifier name: (_) @import.name alias: (_)? @import.alias)))
(import_clause (namespace_import (identifier) @import.name))
(import_clause (identifier) @import.default_name)
(import_statement source: (string (string_fragment) @import.source))

(export_clause (export_specifier name: (_) @export.name alias: (_)? @export.alias))
(export_statement source: (string (string_fragment) @export.source))

(call_expression function: (identifier) @ref.call_name)
(call_expression function: (member_expression object: (_) @ref.qualifier property: (property_identifier) @ref.call_name))
(new_expression constructor: (identifier) @ref.new_name)

(comment) @doc
`;
