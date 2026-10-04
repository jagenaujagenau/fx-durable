import { test } from "node:test"
import assert from "node:assert/strict"
import { applyDiscount, subtotal, total } from "../src/cart.js"

const items = [
  { sku: "apple", price: 50, quantity: 4 },
  { sku: "bread", price: 300, quantity: 1 }
]

test("subtotal multiplies price by quantity", () => {
  assert.equal(subtotal(items), 500)
})

test("applyDiscount takes a percentage off", () => {
  assert.equal(applyDiscount(1000, 10), 900)
})

test("applyDiscount rejects out-of-range percentages", () => {
  assert.throws(() => applyDiscount(1000, 120), RangeError)
})

test("total applies discount, then tax", () => {
  assert.equal(total(items, { discountPercent: 10, taxRate: 0.2 }), 540)
})
