import clsx from 'clsx';
import React, { useState } from 'react';

interface AnnotationToolButtonProps {
  showTooltip: boolean;
  tooltipText: string;
  disabled?: boolean;
  Icon: React.ElementType;
  onClick: () => void;
  labeled?: boolean;
}

const AnnotationToolButton: React.FC<AnnotationToolButtonProps> = ({
  showTooltip,
  tooltipText,
  disabled,
  Icon,
  onClick,
  labeled,
}) => {
  const [buttonClicked, setButtonClicked] = useState(false);
  const handleClick = () => {
    setButtonClicked(true);
    onClick();
  };
  if (labeled) {
    return (
      <button
        type='button'
        onClick={handleClick}
        aria-label={tooltipText}
        disabled={disabled}
        className={clsx(
          'flex h-full min-w-12 flex-1 flex-col items-center justify-center gap-1 rounded-md p-0',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <Icon size={22} />
        <span className='max-w-full truncate text-[11px] font-medium leading-none'>
          {tooltipText}
        </span>
      </button>
    );
  }
  return (
    <div
      className='lg:tooltip lg:tooltip-bottom'
      title={!buttonClicked && showTooltip ? tooltipText : undefined}
    >
      <button
        onClick={handleClick}
        aria-label={tooltipText}
        className={clsx(
          'flex h-8 min-h-8 w-8 items-center justify-center p-0',
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'not-eink:hover:bg-base-200 eink:hover:border rounded-md',
        )}
        disabled={disabled}
      >
        <Icon />
      </button>
    </div>
  );
};

export default AnnotationToolButton;
