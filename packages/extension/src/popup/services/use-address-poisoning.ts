import { useEffect, useState } from 'react'
import type { ActivityReadModel } from '@/core/activity'
import {
  assessAddressPoisoning,
  type AddressPoisoningParty
} from '@/core/security/address-poisoning'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { useAddressBookStore } from '@/store/address-book-store'

export type AddressPoisoningCheck = 'pending' | 'clear' | 'warning' | 'unavailable'

export function addressPoisoningNeedsCaution(status: AddressPoisoningCheck): boolean {
  return status === 'warning' || status === 'unavailable'
}

export function useAddressPoisoningWarning(
  candidate: AddressPoisoningParty | null
): AddressPoisoningCheck {
  const contacts = useAddressBookStore(state => state.contacts)
  const chainId = candidate?.chainId ?? ''
  const address = candidate?.address ?? ''
  const [loaded, setLoaded] = useState<{
    readonly key: string
    readonly model: ActivityReadModel | null
  } | null>(null)

  useEffect(() => {
    if (!chainId || !address) return
    const key = `${chainId}:${address}`
    let cancelled = false
    evmWalletClient.getActivity('read').then(
      model => {
        if (!cancelled) setLoaded({ key, model })
      },
      () => {
        if (!cancelled) setLoaded({ key, model: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [address, chainId])

  if (!candidate) return 'clear'
  if (!loaded || loaded.key !== `${candidate.chainId}:${candidate.address}`) return 'pending'
  if (!loaded.model) return 'unavailable'
  return assessAddressPoisoning({
    candidate,
    activity: loaded.model.items,
    plantedRecipients: loaded.model.plantedRecipients ?? [],
    plantedSenders: loaded.model.plantedSenders ?? [],
    contacts: contacts
      .filter(contact => contact.network === DEFAULT_NETWORK)
      .map(contact => ({ chainId: contact.chainId, address: contact.address }))
  })
    ? 'warning'
    : 'clear'
}
