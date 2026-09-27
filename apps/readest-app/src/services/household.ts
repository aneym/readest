declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_HOUSEHOLD_BUILD?: string;
    }
  }
}

// Next inlines only literal dot access to NEXT_PUBLIC_* — keep it that way.
export const isHouseholdBuild = (): boolean => {
  const flag = process.env.NEXT_PUBLIC_HOUSEHOLD_BUILD;
  return flag === '1' || flag === 'true';
};
