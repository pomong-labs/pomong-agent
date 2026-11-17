export default function Logo({ size = 34, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/brand-mark.svg" width={size} height={size} alt="Pomong Agent" className="select-none" />
      {withText ? (
        <span className="text-[24px] font-bold tracking-[-0.02em] text-[#1F1D2B]">Pomong Agent</span>
      ) : null}
    </div>
  );
}
