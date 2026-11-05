import type { Expression, Literal, SpreadElement } from 'acorn';

/** A value a pure literal evaluates to. */
export type LiteralValue = string | number | boolean | null | undefined | LiteralValue[] | { [key: string]: LiteralValue };

type PlainValue = string | number | boolean | null | undefined;

const plain = (value: Literal['value']): value is PlainValue => typeof value !== 'bigint' && !(value instanceof RegExp);

export function literal(node: Expression | SpreadElement | null | undefined): LiteralValue {
  switch (node?.type) {
    case 'Literal': if (node.regex || !plain(node.value)) break; return node.value;
    case 'TemplateLiteral': if (node.expressions.length === 0) return node.quasis[0].value.cooked; break;
    case 'UnaryExpression': if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value; break;
    case 'ArrayExpression': return node.elements.map(element => literal(element));
    case 'ObjectExpression': {
      const result: { [key: string]: LiteralValue } = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.computed || p.method || p.shorthand || p.kind !== 'init') throw new Error('Expected a pure literal');
        const key = p.key.type === 'Identifier' ? p.key.name : literal(p.key);
        // String() gives the same property key that defineProperty would derive from a non-symbol value.
        Object.defineProperty(result, String(key), { value: literal(p.value), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
  }
  throw new Error('Expected a pure literal');
}
