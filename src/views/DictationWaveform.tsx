import { normalizeWaveform } from "../dictationController";

/** A short history of microphone volume, with the newest sample on the right. */
export function DictationWaveform({ levels }: { levels: readonly number[] }): React.ReactElement {
  const history = normalizeWaveform(levels);
  const samples = [...Array<number>(80 - history.length).fill(0), ...history];
  return (
    <div className="dictation-waveform" aria-hidden="true" data-slot="dictation-waveform">
      <svg viewBox="0 0 560 32" preserveAspectRatio="none" focusable="false">
        {samples.map((level, index) => {
          const height = 2.5 + level * 25.5;
          return <rect key={index} x={index * 7 + 2} y={(32 - height) / 2} width="3" height={height} rx="1.5" opacity={.42 + level * .48} />;
        })}
      </svg>
    </div>
  );
}
