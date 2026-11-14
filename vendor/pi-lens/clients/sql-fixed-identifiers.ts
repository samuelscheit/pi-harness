/**
 * Whether a SQL template interpolates only values the file itself fixes
 * (`ts_sql_injection_sink`'s exemption).
 *
 * The `sql-injection` rule reports a SQL template with any `${…}`. A table or
 * column name cannot be a bound parameter, so code that loops over a fixed
 * table list, or drops every table `sqlite_master` lists, has to interpolate
 * it: `DELETE FROM ${table}` over `const SESSION_TABLES = ["a", "b"]`, and
 * `DROP TABLE IF EXISTS "${name}"` over `SELECT name FROM sqlite_master`
 * stopped the agent on 2026-11-12. Neither value can come from input.
 *
 * A substitution is fixed when it is:
 * - a string or number literal, or a conditional whose two branches are fixed
 *   (`${t === "s" ? "id" : "session_id"}`);
 * - the `const` binding of a `for…of` over an array of string literals,
 *   written in place or as a file-level `const` (`as const` allowed);
 * - the `name` / `tbl_name` of a `for…of` row over
 *   `<db>.prepare("… FROM sqlite_master …").all()` (or `.iterate()`), quoted
 *   as an identifier (`"${name}"`): a schema name is the database's own value,
 *   and the quotes keep it one identifier.
 *
 * Anything else, including a binding the loop body re-declares, keeps the
 * finding (fail closed).
 */

/** The node surface this check reads (web-tree-sitter's `Node`). */
export interface SqlTemplateNode {
	type: string;
	text: string;
	children: SqlTemplateNode[];
	parent?: SqlTemplateNode | null;
	isNamed: boolean;
	childForFieldName?: (field: string) => SqlTemplateNode | null;
}

/**
 * Resolves an identifier node to the value of the file-level `const` it
 * names, or null when it is not one (shadowed, `let`, reassigned, absent).
 */
export type ConstValueResolver = (
	identifier: SqlTemplateNode,
) => SqlTemplateNode | null;

const SCHEMA_TABLE_QUERY =
	/\bFROM\s+(?:(?:main|temp)\.)?sqlite_(?:temp_)?(?:master|schema)\b/i;
const SCHEMA_NAME_COLUMNS = new Set(["name", "tbl_name"]);
const WRAPPERS = new Set([
	"as_expression",
	"satisfies_expression",
	"parenthesized_expression",
	"non_null_expression",
]);

export function sqlTemplateInterpolatesOnlyFixedValues(
	template: SqlTemplateNode,
	resolveConst: ConstValueResolver,
): boolean {
	const parts = template.children;
	let substitutions = 0;
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i]!;
		if (part.type !== "template_substitution") continue;
		substitutions += 1;
		const value = part.children.find((c) => c.isNamed);
		if (!value) return false;
		const quoted =
			(parts[i - 1]?.text.endsWith('"') ?? false) &&
			(parts[i + 1]?.text.startsWith('"') ?? false);
		if (!isFixed(value, quoted, resolveConst)) return false;
	}
	return substitutions > 0;
}

function unwrap(node: SqlTemplateNode): SqlTemplateNode {
	let current = node;
	while (WRAPPERS.has(current.type)) {
		const inner = current.children.find((c) => c.isNamed);
		if (!inner) return current;
		current = inner;
	}
	return current;
}

function isLiteral(node: SqlTemplateNode): boolean {
	return (
		node.type === "string" ||
		node.type === "number" ||
		(node.type === "template_string" &&
			!node.children.some((c) => c.type === "template_substitution"))
	);
}

function isFixed(
	expression: SqlTemplateNode,
	quoted: boolean,
	resolveConst: ConstValueResolver,
): boolean {
	const node = unwrap(expression);
	if (isLiteral(node)) return true;
	if (node.type === "ternary_expression") {
		const consequence = node.childForFieldName?.("consequence");
		const alternative = node.childForFieldName?.("alternative");
		return (
			!!consequence &&
			!!alternative &&
			isFixed(consequence, quoted, resolveConst) &&
			isFixed(alternative, quoted, resolveConst)
		);
	}
	if (node.type === "identifier") {
		const loop = bindingLoop(node, node.text);
		if (!loop) return false;
		const { left, right } = loop;
		if (left.type === "identifier") return isStringArray(right, resolveConst);
		return (
			quoted &&
			destructuresSchemaName(left, node.text) &&
			isSchemaRows(right, resolveConst)
		);
	}
	if (node.type === "member_expression") {
		const object = node.childForFieldName?.("object");
		const property = node.childForFieldName?.("property");
		if (
			!quoted ||
			object?.type !== "identifier" ||
			!SCHEMA_NAME_COLUMNS.has(property?.text ?? "")
		)
			return false;
		const loop = bindingLoop(object, object.text);
		return (
			!!loop &&
			loop.left.type === "identifier" &&
			isSchemaRows(loop.right, resolveConst)
		);
	}
	return false;
}

/**
 * The nearest enclosing `for (const <left> of <right>)` whose `left` binds
 * `name`, with nothing in its body binding it again (a closure parameter, an
 * inner declaration). Null when the binding is not a `const … of`.
 */
function bindingLoop(
	use: SqlTemplateNode,
	name: string,
): { left: SqlTemplateNode; right: SqlTemplateNode } | null {
	for (let node = use.parent; node; node = node.parent) {
		if (node.type !== "for_in_statement") continue;
		const left = node.childForFieldName?.("left");
		const right = node.childForFieldName?.("right");
		if (!left || !right || !bindingNames(left).includes(name)) continue;
		const isConstOf =
			node.children.some((c) => c.type === "const") &&
			node.children.some((c) => c.type === "of");
		const body = node.childForFieldName?.("body");
		if (!isConstOf || !body || rebinds(body, name)) return null;
		return { left, right };
	}
	return null;
}

/** The names a binding pattern introduces. */
function bindingNames(pattern: SqlTemplateNode): string[] {
	switch (pattern.type) {
		case "identifier":
		case "shorthand_property_identifier_pattern":
			return [pattern.text];
		case "pair_pattern": {
			const value = pattern.childForFieldName?.("value");
			return value ? bindingNames(value) : [];
		}
		case "object_pattern":
		case "array_pattern":
			return pattern.children.flatMap(bindingNames);
		default:
			return [];
	}
}

/** Per node type, the field holding the names it binds. */
const BINDING_FIELDS: Readonly<Record<string, string>> = {
	variable_declarator: "name",
	for_in_statement: "left",
	required_parameter: "pattern",
	optional_parameter: "pattern",
	catch_clause: "parameter",
	arrow_function: "parameter",
	function_declaration: "name",
	class_declaration: "name",
};

/** Whether `body` binds `name` anywhere (a shadow this check cannot place). */
function rebinds(body: SqlTemplateNode, name: string): boolean {
	const stack = [body];
	while (stack.length > 0) {
		const node = stack.pop()!;
		const field = BINDING_FIELDS[node.type];
		const pattern = field ? node.childForFieldName?.(field) : undefined;
		if (pattern && bindingNames(pattern).includes(name)) return true;
		stack.push(...node.children);
	}
	return false;
}

/** `{ name }` or `{ name: alias }` (also `tbl_name`) binding `alias`. */
function destructuresSchemaName(
	pattern: SqlTemplateNode,
	name: string,
): boolean {
	if (pattern.type !== "object_pattern") return false;
	return pattern.children.some((property) => {
		if (property.type === "shorthand_property_identifier_pattern")
			return property.text === name && SCHEMA_NAME_COLUMNS.has(name);
		if (property.type !== "pair_pattern") return false;
		const key = property.childForFieldName?.("key")?.text;
		const value = property.childForFieldName?.("value");
		return (
			SCHEMA_NAME_COLUMNS.has(key ?? "") &&
			value?.type === "identifier" &&
			value.text === name
		);
	});
}

function resolve(
	node: SqlTemplateNode,
	resolveConst: ConstValueResolver,
): SqlTemplateNode | null {
	const value = unwrap(node);
	if (value.type !== "identifier") return value;
	const bound = resolveConst(value);
	return bound ? unwrap(bound) : null;
}

/** An array of string literals, in place or through a file-level `const`. */
function isStringArray(
	node: SqlTemplateNode,
	resolveConst: ConstValueResolver,
): boolean {
	const value = resolve(node, resolveConst);
	if (value?.type !== "array") return false;
	return value.children
		.filter((c) => c.isNamed && c.type !== "comment")
		.every(isLiteral);
}

/** `<db>.prepare("… FROM sqlite_master …").all()` / `.iterate()`. */
function isSchemaRows(
	node: SqlTemplateNode,
	resolveConst: ConstValueResolver,
): boolean {
	const value = resolve(node, resolveConst);
	if (value?.type !== "call_expression") return false;
	const read = value.childForFieldName?.("function");
	const rowsMethod = read?.childForFieldName?.("property")?.text;
	if (
		read?.type !== "member_expression" ||
		(rowsMethod !== "all" && rowsMethod !== "iterate")
	)
		return false;
	const prepare = unwrap(read.childForFieldName?.("object") ?? read);
	const prepareFn = prepare.childForFieldName?.("function");
	if (
		prepare.type !== "call_expression" ||
		prepareFn?.type !== "member_expression" ||
		prepareFn.childForFieldName?.("property")?.text !== "prepare"
	)
		return false;
	const query = prepare
		.childForFieldName?.("arguments")
		?.children.find((c) => c.isNamed);
	return !!query && isLiteral(query) && SCHEMA_TABLE_QUERY.test(query.text);
}
