import { Icon } from '@iconify/react'
import { ADDRESS_POISONING_WARNING } from '@/core/security/address-poisoning'

export function AddressPoisoningNotice() {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-surface px-3 py-2.5 text-xs leading-5 text-warning"
    >
      <Icon icon="lucide:triangle-alert" width={15} height={15} className="mt-0.5 shrink-0" />
      <span>{ADDRESS_POISONING_WARNING}</span>
    </div>
  )
}
