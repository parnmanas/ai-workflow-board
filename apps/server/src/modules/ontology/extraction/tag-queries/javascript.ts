// tree-sitter tags 스타일 쿼리 — 순수 `javascript` 문법 전용(ticket e14ef1c9).
// `typescript-family.ts`의 자매 파일 — 공유하지 않는 이유는 그 파일 상단
// 코멘트 참고. `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`로 검증됨.
export const JAVASCRIPT_TAGS_QUERY = `
(function_declaration name: (identifier) @def.name) @def.function

(class_declaration name: (_) @def.name) @def.class

(method_definition name: (property_identifier) @def.name) @def.method

(field_definition property: (property_identifier) @def.name) @def.field

(variable_declarator name: (identifier) @def.name value: [(arrow_function) (function_expression)]) @def.arrow

(class_declaration
  name: (_) @heritage.class_name
  (class_heritage (_) @heritage.extends_target))

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
