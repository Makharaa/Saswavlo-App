"use client";

import { MapPin } from "lucide-react";
import { AppSelect } from "@/components/app-select";

export function CitySelect({
  cities,
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  cities: string[];
  value: string;
  onChange: (city: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <AppSelect
      className={className}
      value={value}
      onChange={onChange}
      label="ქალაქი"
      ariaLabel="ქალაქის არჩევა"
      startIcon={<MapPin size={16} />}
      disabled={disabled || cities.length === 0}
      options={cities.map((city) => ({ value: city, label: city }))}
    />
  );
}
