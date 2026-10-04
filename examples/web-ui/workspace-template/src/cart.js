/** A line item: { sku, price (in cents), quantity }. */

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0)
}

export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100")
  return Math.round(amount - amount * (percent / 100))
}

export function total(items, { discountPercent = 0, taxRate = 0 } = {}) {
  const discounted = applyDiscount(subtotal(items), discountPercent)
  return Math.round(discounted * (1 + taxRate))
}
