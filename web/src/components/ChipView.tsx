import type { Chip } from '../lib/search';

export const TYPE_LABEL = { lex: 'Leksikalsk', person: 'Person', tema: 'Tema' } as const;

interface Props {
  chip: Chip;
  onCycle?: () => void;
  onApprove?: () => void;
  onRemove?: () => void;
}

export function ChipView({ chip, onCycle, onApprove, onRemove }: Props) {
  const Tag = onCycle ? 'button' : 'span';
  return (
    <span className={'chip' + (chip.ok ? '' : ' pending')} data-testid="chip">
      <Tag className={'chip-tag ' + chip.type} title={onCycle ? 'Bytt type' : undefined} onClick={onCycle}>{TYPE_LABEL[chip.type]}</Tag>
      <span className="chip-val">{chip.val}</span>
      {!chip.ok && onApprove && <button className="chip-ok" title="Godkjenn" onClick={onApprove}>✓</button>}
      {onRemove && <button className="chip-x" title="Fjern" onClick={onRemove}>×</button>}
    </span>
  );
}
